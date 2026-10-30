import { rollingGoObjects, rollingGoActions, rollingGoFunctions } from './rollinggo.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { assertBusinessTransaction, businessTransaction } from '../core/transaction.js';
import { definitionKindSchema, ontologyIdSchema, ontologyReleaseRefSchema, parseOntologyDocument, resourceIdSchema,
  type DefinitionKind, type OntologyDocument, type OntologyReleaseRef, type SerializableAction, type SerializableInterface,
  type SerializableLink, type SerializableObjectType } from './definition-contracts.js';
import { compileOntologyDocument, normalizeOntologyDocument, validateBusinessDefinitionExtensions, type TrustedDefinitionRegistry } from './model-compiler.js';
import { createCurrentKernelDefinition, createSeedDefinition, createRollingGoKernelDefinition, createTaskClosureKernelDefinition } from './seed-definition.js';
import { businessFactTypes, businessFactLinks } from './business-facts.js';
import type { OntologyModel } from './model.js';
import { rideEstimateObjects, rideEstimateActions, rideEstimateFunctions } from './ride-estimate.js';
import { PipelineStore } from './pipeline/store.js';

export type DefinitionResource = SerializableObjectType | SerializableInterface | SerializableLink | SerializableAction;
export interface DefinitionEntry { kind: DefinitionKind; definition: DefinitionResource }
export interface DefinitionCompatibilityInput {
  kind: 'object' | 'link'; id: string; storedDigest: string; currentDigest: string; properties?: Record<string, unknown>;
}
export interface ResolvedOntologyRelease {
  readonly ref: OntologyReleaseRef; readonly model: OntologyModel; readonly document: OntologyDocument; readonly createdAt: string; readonly sequence: number;
  readonly compatibleDefinition: (input: DefinitionCompatibilityInput) => boolean;
}
export interface OntologyNamespace {
  id: string; owner: string | null; name: string; active: OntologyReleaseRef; generation: number; createdAt: string;
}
export interface DefinitionDraft {
  id: string; ontologyId: string; owner: string; base: OntologyReleaseRef; baseGeneration: number; revision: number;
  status: 'open' | 'published' | 'discarded'; title: string; document: OntologyDocument; createdAt: string; updatedAt: string;
  published?: OntologyReleaseRef;
}
export interface DefinitionChange { kind: DefinitionKind; resourceId: string; id: string; change: 'added' | 'modified' | 'retired'; fields: string[] }
export interface DefinitionValidation {
  valid: boolean; draftId: string; revision: number; documentDigest: string; changes: DefinitionChange[];
  issues: { code: string; message: string }[]; migrationRequired: boolean;
  unboundSourceFields: { type: string; property: string }[];
  counts?: { objects: number; interfaces: number; links: number; actions: number };
}

const DEFAULT_ONTOLOGY = 'eigos.business';
const tableKey = { object: 'objects', interface: 'interfaces', link: 'links', action: 'actions' } as const;
const category = (kind: DefinitionKind) => ['object', 'interface'].includes(kind) ? 'type' : kind;
const entries = (document: OntologyDocument): DefinitionEntry[] => (Object.keys(tableKey) as DefinitionKind[])
  .flatMap(kind => document[tableKey[kind]].map(definition => ({ kind, definition })));
const conflict = (message: string): never => { throw new DomainError('CONFLICT', message); };
const invalid = (message: string): never => { throw new DomainError('INVALID_INPUT', message); };
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
let templates: { registry: TrustedDefinitionRegistry; legacy: OntologyDocument; kernel: OntologyDocument; legacyModel: OntologyModel } | undefined;
// This cache contains definitions only. Database identity, data compatibility and
// current permission checks still run separately for each store and request.
const compiledModels = new Map<string, OntologyModel>();
function compiledModel(document: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyModel {
  const key = digest(document), cached = compiledModels.get(key);
  if (cached) { compiledModels.delete(key); compiledModels.set(key, cached); return cached; }
  const model = compileOntologyDocument(document, registry);
  compiledModels.set(key, model);
  if (compiledModels.size > 16) compiledModels.delete(compiledModels.keys().next().value!);
  return model;
}
function trustedTemplates() {
  if (!templates) {
    const legacy = createSeedDefinition(), kernel = createCurrentKernelDefinition(legacy.registry);
    templates = { registry: legacy.registry, legacy: freezeJson(legacy.document), kernel: freezeJson(kernel.document), legacyModel: compiledModel(legacy.document, legacy.registry) };
  }
  return templates;
}

/** Canonical reviewed kernel, independent of owner-authored active releases. */
export function currentKernelImplementation(): OntologyModel { const value = trustedTemplates(); return compiledModel(value.kernel, value.registry); }

/** Persistent metadata, independent of facts and authority. All returned models
 * are immutable release compilations; authorization is never cached here. */
export class DefinitionStore {
  private pipelineStore?: PipelineStore;
  get pipeline(): PipelineStore {
    if (!this.pipelineStore) throw new DomainError('FORBIDDEN', 'Read-only definition readers do not expose pipeline management');
    return this.pipelineStore;
  }
  private readonly registry: TrustedDefinitionRegistry;
  private readonly models = new Map<string, ResolvedOntologyRelease>();
  private readonly readOnly: boolean;
  constructor(private readonly db: DatabaseSync, readonly now: () => number = Date.now, options: {readOnly?:boolean} = {}) {
    this.readOnly=!!options.readOnly;
    this.registry = trustedTemplates().registry;
    if(this.readOnly)return;
    this.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS ontology_namespaces (id TEXT PRIMARY KEY,owner TEXT,name TEXT NOT NULL,active_release_id TEXT,generation INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ontology_definition_releases (id TEXT PRIMARY KEY,ontology_id TEXT NOT NULL,sequence INTEGER NOT NULL,digest TEXT NOT NULL,model_digest TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(ontology_id,sequence),UNIQUE(ontology_id,digest));
      CREATE TABLE IF NOT EXISTS ontology_definition_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1),legacy_ref TEXT NOT NULL,kernel_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ontology_definition_drafts (id TEXT PRIMARY KEY,ontology_id TEXT NOT NULL,owner TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ontology_definition_names (ontology_id TEXT NOT NULL,category TEXT NOT NULL,api_name TEXT NOT NULL,resource_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(ontology_id,category,api_name),UNIQUE(ontology_id,resource_id));
      CREATE TABLE IF NOT EXISTS ontology_definition_revisions (ontology_id TEXT NOT NULL,resource_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,api_name TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(ontology_id,resource_id,revision),UNIQUE(ontology_id,resource_id,digest));
      CREATE TABLE IF NOT EXISTS ontology_definition_fingerprints (ontology_id TEXT NOT NULL,kind TEXT NOT NULL,api_name TEXT NOT NULL,fingerprint TEXT NOT NULL,release_id TEXT NOT NULL,PRIMARY KEY(ontology_id,kind,api_name,fingerprint));
      CREATE TABLE IF NOT EXISTS ontology_definition_events (id TEXT PRIMARY KEY,ontology_id TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ontology_definition_lineage (release_id TEXT PRIMARY KEY,ontology_id TEXT NOT NULL,base_ref TEXT);
      CREATE TABLE IF NOT EXISTS ontology_definition_promotions (ontology_id TEXT NOT NULL,release_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(ontology_id,release_id));
      CREATE TABLE IF NOT EXISTS ontology_definition_release_aliases (alias_id TEXT PRIMARY KEY,ontology_id TEXT NOT NULL,canonical_id TEXT NOT NULL,digest TEXT NOT NULL,source_authority TEXT NOT NULL,created_at TEXT NOT NULL);
    `));
    this.transaction(() => {
      for (const table of ['ontology_definition_releases', 'ontology_definition_revisions', 'ontology_definition_names', 'ontology_definition_fingerprints', 'ontology_definition_events', 'ontology_definition_lineage', 'ontology_definition_promotions', 'ontology_definition_release_aliases']) {
        for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Ontology definition history is immutable'); END`);
      }
    });
    this.pipelineStore = this.transaction(() => new PipelineStore(this.db, this.now));
  }
  private transaction<T>(action: () => T): T {
    if(this.readOnly)throw new DomainError('FORBIDDEN','Read-only definition readers cannot change published metadata');
    let owned = false;
    try { assertBusinessTransaction(this.db); owned = true; }
    catch (error) { if (!(error instanceof DomainError && error.code === 'CONFLICT')) throw error; }
    return owned ? action() : businessTransaction(this.db, action);
  }
  hasBaseline(): boolean { return !!this.db.prepare('SELECT 1 FROM ontology_definition_bootstrap WHERE id=1').get(); }
  legacyImplementation(): OntologyModel { return trustedTemplates().legacyModel; }
  bootstrap(): ResolvedOntologyRelease {
    if (!this.hasBaseline()) this.transaction(() => {
      if (this.hasBaseline()) return;
      const at = new Date(this.now()).toISOString();
      this.db.prepare('INSERT INTO ontology_namespaces VALUES(?,NULL,?,NULL,0,?)').run(DEFAULT_ONTOLOGY, 'EIGOS business', at);
      const legacy = this.insertRelease(trustedTemplates().legacy, 'system:bootstrap');
      const kernel = digest(trustedTemplates().kernel) === digest(trustedTemplates().legacy) ? legacy : this.insertRelease(trustedTemplates().kernel, 'system:bootstrap');
      this.db.prepare('UPDATE ontology_namespaces SET active_release_id=?,generation=1 WHERE id=?').run(kernel.ref.releaseId, DEFAULT_ONTOLOGY);
      this.db.prepare('INSERT INTO ontology_definition_bootstrap VALUES(1,?,?)').run(JSON.stringify(legacy.ref), JSON.stringify(kernel.ref));
      this.recordPromotion(legacy.ref); this.recordPromotion(kernel.ref);
      this.event(DEFAULT_ONTOLOGY, 'system:bootstrap', 'bootstrap', { legacy: legacy.ref, active: kernel.ref });
    });
    return this.active();
  }
  legacy(): ResolvedOntologyRelease {
    const row = this.db.prepare('SELECT legacy_ref FROM ontology_definition_bootstrap WHERE id=1').get();
    if (!row) return conflict('Ontology definitions have not been initialized');
    return this.resolve(JSON.parse(String(row.legacy_ref)));
  }
  /** Explicit operator installation; never called by startup or a model. Keeps
   * every existing definition and fixed task release, adding only DiDi reads. */
  installDidiReadonly(expected: OntologyReleaseRef, expectedGeneration: number): OntologyNamespace {
    return this.transaction(() => {
      const namespace = this.namespace();
      if (digest(namespace.active) !== digest(expected) || namespace.generation !== expectedGeneration) return conflict('Active ontology changed before the DiDi installation');
      const document = structuredClone(this.resolve(namespace.active).document), kernel = createTaskClosureKernelDefinition(trustedTemplates().registry).document;
      const types = new Set(rideEstimateObjects.map(value => value.id));
      const availableTypes = new Set([...document.objects, ...document.interfaces, ...rideEstimateObjects].map(value => value.id));
      const actions = new Set(rideEstimateActions.map(value => value.id)), functions = new Set(rideEstimateFunctions.map(value => value.id));
      const additions = { objects: kernel.objects.filter(value => types.has(value.id)),
        links: kernel.links.filter(value => (types.has(value.from.type) || types.has(value.to.type)) && availableTypes.has(value.from.type) && availableTypes.has(value.to.type)),
        actions: kernel.actions.filter(value => actions.has(value.id)), functions: kernel.functions.filter(value => functions.has(value.id)) };
      let changed = false;
      for (const key of ['objects', 'links', 'actions', 'functions'] as const) for (const value of additions[key]) {
        const current = document[key].find(item => item.id === value.id);
        if (current && digest(current) !== digest(value)) return conflict('DiDi installation would replace an existing definition');
        if (!current) { (document[key] as unknown[]).push(structuredClone(value)); changed = true; }
      }
      if (!changed) return namespace;
      document.version = `didi-readonly-${namespace.generation + 1}`;
      const release = this.insertRelease(document, 'system:install-didi-readonly', namespace.active);
      return this.activate('system:install-didi-readonly', release.ref, expectedGeneration, true);
    });
  }
  /** Explicit additive provider installation. Existing facts, task pins and
   * non-RollingGo definitions remain unchanged; no source permissions are granted. */
  installRollingGoReadonly(expected: OntologyReleaseRef, expectedGeneration: number): OntologyNamespace {
    return this.transaction(() => {
      const namespace = this.namespace();
      if (digest(namespace.active) !== digest(expected) || namespace.generation !== expectedGeneration) return conflict('Active ontology changed before the RollingGo installation');
      const document = structuredClone(this.resolve(namespace.active).document), kernel = createRollingGoKernelDefinition(trustedTemplates().registry).document;
      const types = new Set(rollingGoObjects.map(value => value.id));
      const availableTypes = new Set([...document.objects, ...document.interfaces, ...rollingGoObjects].map(value => value.id));
      const actions = new Set(rollingGoActions.map(value => value.id)), functions = new Set(rollingGoFunctions.map(value => value.id));
      const additions = { objects: kernel.objects.filter(value => types.has(value.id)),
        links: kernel.links.filter(value => (types.has(value.from.type) || types.has(value.to.type)) && availableTypes.has(value.from.type) && availableTypes.has(value.to.type)),
        actions: kernel.actions.filter(value => actions.has(value.id)), functions: kernel.functions.filter(value => functions.has(value.id)) };
      let changed = false;
      for (const key of ['objects', 'links', 'actions', 'functions'] as const) for (const value of additions[key]) {
        const current = document[key].find(item => item.id === value.id);
        if (current && digest(current) !== digest(value)) return conflict('RollingGo installation would replace an existing definition');
        if (!current) { (document[key] as unknown[]).push(structuredClone(value)); changed = true; }
      }
      if (!changed) return namespace;
      document.version = `rollinggo-readonly-${namespace.generation + 1}`;
      const release = this.insertRelease(document, 'system:install-rollinggo-readonly', namespace.active);
      return this.activate('system:install-rollinggo-readonly', release.ref, expectedGeneration, true);
    });
  }
  /** Explicit v23 -> v24 source-fact projection release. No startup activation,
   * data rewrite, task pin change, source grant or provider operation occurs. */
  installBusinessFacts(expected: OntologyReleaseRef, expectedGeneration: number): OntologyNamespace {
    return this.transaction(() => {
      const namespace = this.namespace();
      if (digest(namespace.active) !== digest(expected) || namespace.generation !== expectedGeneration) return conflict('Active ontology changed before the business-facts installation');
      const current = this.resolve(namespace.active), kernel = trustedTemplates().kernel;
      if (current.model.ref.digest === compiledModel(kernel, trustedTemplates().registry).ref.digest) return namespace;
      if (current.model.ref.digest !== '2c39527a5973ae4b09b402f382ef192d13f1fca0f5cf3424bcd410b8c3c0a127') return conflict('Business facts require the exact reviewed v23 predecessor');
      const document = structuredClone(current.document), linkIds = new Set(businessFactLinks.map(link => link.id));
      for (const type of document.objects) {
        const next = kernel.objects.find(value => value.id === type.id);
        if (next?.visibility === 'technical') type.visibility = 'technical';
      }
      document.interfaces.push(...kernel.interfaces.filter(type => !document.interfaces.some(previous => previous.id === type.id)));
      for (const id of ['HotelProperty', 'RideRoute', 'TravelLeg', 'Place', 'SavedAddress']) document.objects.find(type => type.id === id)!.interfaces = structuredClone(kernel.objects.find(type => type.id === id)!.interfaces);
      document.objects.push(...kernel.objects.filter(type => businessFactTypes.includes(type.id)));
      document.links.push(...kernel.links.filter(link => linkIds.has(link.id)));
      document.functions.push(...kernel.functions.filter(fn => fn.id === 'businessFactStatus'));
      document.version = `business-facts-${namespace.generation + 1}`;
      const release = this.insertRelease(document, 'system:install-business-facts', namespace.active);
      return this.activate('system:install-business-facts', release.ref, expectedGeneration, true);
    });
  }
  namespace(id = DEFAULT_ONTOLOGY): OntologyNamespace {
    ontologyIdSchema.parse(id);
    const row = this.db.prepare('SELECT n.*,r.digest FROM ontology_namespaces n JOIN ontology_definition_releases r ON r.id=n.active_release_id WHERE n.id=?').get(id);
    if (!row) throw new DomainError('NOT_FOUND', 'Ontology is not available');
    return { id: String(row.id), owner: row.owner === null ? null : String(row.owner), name: String(row.name),
      active: { ontologyId: id, releaseId: String(row.active_release_id), digest: String(row.digest) }, generation: Number(row.generation), createdAt: String(row.created_at) };
  }
  assertAccess(owner: string, ontologyId: string, admin = false): void {
    const namespace = this.namespace(ontologyId);
    if (namespace.owner !== null && namespace.owner !== owner && !admin) throw new DomainError('FORBIDDEN', 'Ontology belongs to another owner');
  }
  assertManagement(owner: string, ontologyId: string, admin = false): void {
    const namespace = this.namespace(ontologyId);
    if (namespace.owner !== owner && !admin) throw new DomainError('FORBIDDEN', 'Ontology management requires its owner or an administrator');
  }
  namespaces(owner: string, admin = false): OntologyNamespace[] {
    const rows = admin ? this.db.prepare('SELECT id FROM ontology_namespaces ORDER BY id').all()
      : this.db.prepare('SELECT id FROM ontology_namespaces WHERE owner IS NULL OR owner=? ORDER BY id').all(owner);
    return rows.map(row => this.namespace(String(row.id)));
  }
  createNamespace(owner: string, input: { id?: string; name: string }): OntologyNamespace {
    const id = ontologyIdSchema.parse(input.id ?? `ontology-${randomUUID()}`);
    if (!owner || owner.length > 2000 || !input.name.trim() || input.name.length > 200) invalid('Invalid ontology owner or name');
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM ontology_namespaces WHERE id=?').get(id)) conflict('Ontology identity already exists');
      this.db.prepare('INSERT INTO ontology_namespaces VALUES(?,?,?,NULL,0,?)').run(id, owner, input.name.trim(), new Date(this.now()).toISOString());
      const document = structuredClone(trustedTemplates().kernel); document.id = id; document.version = '1';
      const release = this.insertRelease(document, owner);
      this.db.prepare('UPDATE ontology_namespaces SET active_release_id=?,generation=1 WHERE id=?').run(release.ref.releaseId, id);
      this.recordPromotion(release.ref);
      this.event(id, owner, 'created', { release: release.ref });
      return this.namespace(id);
    });
  }
  active(ontologyId = DEFAULT_ONTOLOGY): ResolvedOntologyRelease { return this.resolve(this.namespace(ontologyId).active); }
  private releaseRecord(ref: OntologyReleaseRef) {
    return this.db.prepare('SELECT * FROM ontology_definition_releases WHERE id=? AND ontology_id=? AND digest=?').get(ref.releaseId, ref.ontologyId, ref.digest)
      ?? this.db.prepare('SELECT r.* FROM ontology_definition_release_aliases a JOIN ontology_definition_releases r ON r.id=a.canonical_id AND r.ontology_id=a.ontology_id AND r.digest=a.digest WHERE a.alias_id=? AND a.ontology_id=? AND a.digest=?').get(ref.releaseId, ref.ontologyId, ref.digest);
  }
  private releaseModelDigest(ref: OntologyReleaseRef): unknown {
    const row=this.db.prepare('SELECT model_digest FROM ontology_definition_releases WHERE id=? AND ontology_id=? AND digest=?').get(ref.releaseId,ref.ontologyId,ref.digest)
      ?? this.db.prepare('SELECT r.model_digest FROM ontology_definition_release_aliases a JOIN ontology_definition_releases r ON r.id=a.canonical_id AND r.ontology_id=a.ontology_id AND r.digest=a.digest WHERE a.alias_id=? AND a.ontology_id=? AND a.digest=?').get(ref.releaseId,ref.ontologyId,ref.digest);
    return row?.model_digest;
  }
  /** Offline consolidation preserves original task pins, even when independent
   * registries assigned different IDs to byte-identical definitions. There is
   * one canonical content record; aliases never publish or activate a model. */
  importHistoricalRelease(input: { sourceAuthority: string; ref: OntologyReleaseRef; document: OntologyDocument; modelDigest: string }): OntologyReleaseRef {
    const ref = ontologyReleaseRefSchema.parse(input.ref), document = normalizeOntologyDocument(input.document);
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.sourceAuthority) || ref.ontologyId !== DEFAULT_ONTOLOGY || document.id !== ref.ontologyId || digest(document) !== ref.digest)
      return invalid('Historical definition source or content differs from its exact reference');
    const model = compiledModel(document, this.registry);
    if (model.ref.digest !== input.modelDigest) return conflict('Historical definition implementation is unavailable');
    return this.transaction(() => {
      const occupied = this.db.prepare('SELECT ontology_id,digest FROM ontology_definition_releases WHERE id=?').get(ref.releaseId)
        ?? this.db.prepare('SELECT ontology_id,digest FROM ontology_definition_release_aliases WHERE alias_id=?').get(ref.releaseId);
      if (occupied && (occupied.ontology_id !== ref.ontologyId || occupied.digest !== ref.digest)) return conflict('Historical release ID collides with different content');
      const canonical = this.insertRelease(document, 'operator:consolidation');
      if (canonical.ref.releaseId !== ref.releaseId && !occupied) {
        this.db.prepare('INSERT INTO ontology_definition_release_aliases VALUES(?,?,?,?,?,?)').run(ref.releaseId, ref.ontologyId, canonical.ref.releaseId, ref.digest, input.sourceAuthority, new Date(this.now()).toISOString());
        this.event(ref.ontologyId, 'operator:consolidation', 'historical_alias_imported', { sourceAuthority: input.sourceAuthority, original: ref, canonical: canonical.ref });
      }
      this.resolve(ref);
      return { ...canonical.ref };
    });
  }
  resolve(input: OntologyReleaseRef): ResolvedOntologyRelease {
    const ref = ontologyReleaseRefSchema.parse(input), key = JSON.stringify(ref);
    const cached = this.models.get(key);
    if (cached) {
      if (this.releaseModelDigest(ref) !== cached.model.ref.digest) return conflict('The exact ontology release is unavailable');
      this.models.delete(key); this.models.set(key, cached);
      return cached;
    }
    const row = this.releaseRecord(ref);
    if (!row) return conflict('The exact ontology release is unavailable');
    const document = parseOntologyDocument(JSON.parse(String(row.body)));
    if (document.id !== ref.ontologyId || digest(document) !== ref.digest) return conflict('Stored ontology release digest is invalid');
    const model = compiledModel(document, this.registry);
    if (model.ref.digest !== row.model_digest) return conflict('Ontology compiler or trusted handler contract changed');
    const result: ResolvedOntologyRelease = { ref: freezeJson({ ...ref }), model, document: freezeJson(document), createdAt: String(row.created_at), sequence: Number(row.sequence),
      compatibleDefinition: input => this.compatible(ref, model, input) };
    Object.freeze(result); this.models.set(key, result);
    if (this.models.size > 16) this.models.delete(this.models.keys().next().value!);
    return result;
  }
  private compatible(ref: OntologyReleaseRef, target: OntologyModel, input: DefinitionCompatibilityInput): boolean {
    try {
      const row = this.db.prepare('SELECT f.release_id,r.digest FROM ontology_definition_fingerprints f JOIN ontology_definition_releases r ON r.id=f.release_id WHERE f.ontology_id=? AND f.kind=? AND f.api_name=? AND f.fingerprint=?').get(ref.ontologyId, input.kind, input.id, input.storedDigest);
      if (!row) return false;
      const original = this.resolve({ ontologyId: ref.ontologyId, releaseId: String(row.release_id), digest: String(row.digest) }).model;
      if (input.kind === 'link') {
        const old = original.link(input.id), current = target.link(input.id);
        return digest(old) === input.storedDigest && digest(current) === input.currentDigest && digest({ from: old.from, to: old.to, writePolicy: old.writePolicy }) === digest({ from: current.from, to: current.to, writePolicy: current.writePolicy });
      }
      if (!input.properties || original.fingerprint(input.id) !== input.storedDigest || target.fingerprint(input.id) !== input.currentDigest) return false;
      const old = original.object(input.id), current = target.object(input.id);
      if (old.primaryKey !== current.primaryKey || old.titleKey !== current.titleKey || original.objectWritePolicy(input.id) !== target.objectWritePolicy(input.id)) return false;
      const before = original.parseProperties(input.id, input.properties), after = target.parseProperties(input.id, input.properties);
      return digest(before) === digest(input.properties) && digest(after) === digest(input.properties);
    } catch { return false; }
  }
  private event(ontologyId: string, actor: string, kind: string, body: unknown): void {
    this.db.prepare('INSERT INTO ontology_definition_events VALUES(?,?,?,?,?,?)').run(randomUUID(), ontologyId, actor, kind, JSON.stringify(body), new Date(this.now()).toISOString());
  }
  private recordPromotion(ref: OntologyReleaseRef): void {
    this.db.prepare('INSERT OR IGNORE INTO ontology_definition_promotions VALUES(?,?,?)').run(ref.ontologyId, ref.releaseId, new Date(this.now()).toISOString());
  }
  private insertRelease(input: OntologyDocument, actor: string, base?: OntologyReleaseRef): ResolvedOntologyRelease {
    assertBusinessTransaction(this.db);
    const document = normalizeOntologyDocument(input), model = compiledModel(document, this.registry), contentDigest = digest(document);
    const existing = this.db.prepare('SELECT id,digest FROM ontology_definition_releases WHERE ontology_id=? AND digest=?').get(document.id, contentDigest);
    if (existing) return this.resolve({ ontologyId: document.id, releaseId: String(existing.id), digest: String(existing.digest) });
    const sequence = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ontology_definition_releases WHERE ontology_id=?').get(document.id)!.next);
    const at = new Date(this.now()).toISOString(), ref = { ontologyId: document.id, releaseId: randomUUID(), digest: contentDigest };
    for (const { kind, definition } of entries(document)) {
      const lock = this.db.prepare('SELECT * FROM ontology_definition_names WHERE ontology_id=? AND (resource_id=? OR (category=? AND api_name=?))').get(document.id, definition.resourceId, category(kind), definition.id);
      if (lock && (lock.kind !== kind || lock.api_name !== definition.id || lock.resource_id !== definition.resourceId)) conflict('Published definition identities and API names cannot be reused or renamed');
      if (!lock) this.db.prepare('INSERT INTO ontology_definition_names VALUES(?,?,?,?,?)').run(document.id, category(kind), definition.id, definition.resourceId, kind);
      const definitionDigest = digest(definition);
      if (!this.db.prepare('SELECT 1 FROM ontology_definition_revisions WHERE ontology_id=? AND resource_id=? AND digest=?').get(document.id, definition.resourceId, definitionDigest)) {
        const revision = Number(this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS next FROM ontology_definition_revisions WHERE ontology_id=? AND resource_id=?').get(document.id, definition.resourceId)!.next);
        this.db.prepare('INSERT INTO ontology_definition_revisions VALUES(?,?,?,?,?,?,?,?)').run(document.id, definition.resourceId, revision, kind, definition.id, definitionDigest, JSON.stringify(definition), at);
      }
    }
    this.db.prepare('INSERT INTO ontology_definition_releases VALUES(?,?,?,?,?,?,?)').run(ref.releaseId, document.id, sequence, ref.digest, model.ref.digest, JSON.stringify(document), at);
    this.db.prepare('INSERT INTO ontology_definition_lineage VALUES(?,?,?)').run(ref.releaseId, document.id, base ? JSON.stringify(base) : null);
    for (const object of document.objects) this.db.prepare('INSERT OR IGNORE INTO ontology_definition_fingerprints VALUES(?,?,?,?,?)').run(document.id, 'object', object.id, model.fingerprint(object.id), ref.releaseId);
    for (const link of document.links) this.db.prepare('INSERT OR IGNORE INTO ontology_definition_fingerprints VALUES(?,?,?,?,?)').run(document.id, 'link', link.id, digest(model.link(link.id)), ref.releaseId);
    this.event(document.id, actor, 'release_created', { release: ref, model: model.ref });
    // Only cache after the caller commits. A rolled-back draft/release may reuse
    // no durable identity; resolve always verifies its durable row first.
    return Object.freeze({ ref: freezeJson(ref), model, document: freezeJson(document), createdAt: at, sequence, compatibleDefinition: (input: DefinitionCompatibilityInput) => this.compatible(ref, model, input) });
  }
  createDraft(owner: string, ontologyId: string, title: string, admin = false): DefinitionDraft {
    this.assertManagement(owner, ontologyId, admin);
    if (!title.trim() || title.length > 200) invalid('Draft title is required');
    return this.transaction(() => {
      const namespace = this.namespace(ontologyId), base = this.resolve(namespace.active), at = new Date(this.now()).toISOString();
      const draft: DefinitionDraft = { id: randomUUID(), ontologyId, owner, base: { ...base.ref }, baseGeneration: namespace.generation, revision: 1, status: 'open', title: title.trim(), document: structuredClone(base.document), createdAt: at, updatedAt: at };
      this.db.prepare('INSERT INTO ontology_definition_drafts VALUES(?,?,?,?,?,?)').run(draft.id, ontologyId, owner, 1, 'open', JSON.stringify(draft));
      this.event(ontologyId, owner, 'draft_created', { draftId: draft.id, base: draft.base }); return draft;
    });
  }
  draft(id: string): DefinitionDraft {
    const row = this.db.prepare('SELECT * FROM ontology_definition_drafts WHERE id=?').get(resourceIdSchema.parse(id));
    if (!row) throw new DomainError('NOT_FOUND', 'Definition draft is not available');
    const draft = JSON.parse(String(row.body)) as DefinitionDraft;
    if (draft.id !== id || draft.ontologyId !== row.ontology_id || draft.owner !== row.owner || draft.revision !== row.revision || draft.status !== row.status) return conflict('Definition draft record is inconsistent');
    return draft;
  }
  drafts(ontologyId: string): Omit<DefinitionDraft, 'document'>[] {
    return this.draftPage(ontologyId, { limit: 100, offset: 0 }).items;
  }
  draftPage(ontologyId: string, page: { limit: number; offset: number }) {
    const { limit, offset } = this.pagination(page);
    const total = Number(this.db.prepare('SELECT count(*) AS count FROM ontology_definition_drafts WHERE ontology_id=?').get(ontologyId)!.count);
    const items = this.db.prepare("SELECT json_remove(body,'$.document') AS summary FROM ontology_definition_drafts WHERE ontology_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?").all(ontologyId, limit, offset)
      .map(row => JSON.parse(String(row.summary)) as Omit<DefinitionDraft, 'document'>);
    return { items, total, page: { limit, offset, hasMore: offset + items.length < total } };
  }
  private pagination(page: { limit: number; offset: number }) {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100 || !Number.isInteger(page.offset) || page.offset < 0 || page.offset > 10000) invalid('Invalid definition history page');
    return page;
  }
  private saveDraft(draft: DefinitionDraft, expectedRevision: number): DefinitionDraft {
    draft.revision = expectedRevision + 1; draft.updatedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare('UPDATE ontology_definition_drafts SET revision=?,status=?,body=? WHERE id=? AND revision=?').run(draft.revision, draft.status, JSON.stringify(draft), draft.id, expectedRevision);
    if (result.changes !== 1) return conflict('Definition draft revision changed'); return draft;
  }
  private assertPipelineIdentity(ontologyId: string, prior: NonNullable<OntologyDocument['pipeline']>[number], next: NonNullable<OntologyDocument['pipeline']>[number] | undefined): void {
    if (!next) return conflict('Activation cannot remove governed service intake policies');
    const before = this.pipeline.intake(ontologyId, prior), after = this.pipeline.intake(ontologyId, next);
    if (before.programRef.id !== after.programRef.id || before.source.id !== after.source.id || before.actions.some(action => !after.actions.some(value => value.actionId === action.actionId)))
      return conflict('A governed service/action identity cannot be removed or reassigned; publish definition_only to retire execution');
  }
  putPipeline(owner: string, draftId: string, expectedRevision: number, input: unknown, admin = false): DefinitionDraft {
    return this.transaction(() => {
      const draft = this.draft(draftId); this.assertManagement(owner, draft.ontologyId, admin);
      if (draft.status !== 'open' || draft.revision !== expectedRevision) return conflict('Draft is not open at the expected revision');
      const ref = this.pipeline.put(draft.ontologyId, owner, input);
      const prior = draft.document.pipeline?.find(value => value.serviceId === ref.serviceId);
      if (prior) this.assertPipelineIdentity(draft.ontologyId, prior, ref);
      draft.document.pipeline = [...(draft.document.pipeline ?? []).filter(value => value.serviceId !== ref.serviceId), ref].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      draft.document = parseOntologyDocument(draft.document);
      this.event(draft.ontologyId, owner, 'pipeline_intake_edited', { draftId, ...ref });
      return this.saveDraft(draft, expectedRevision);
    });
  }
  pipelineDraft(owner: string, draftId: string, expectedRevision: number, serviceId: string, admin = false) {
    const draft = this.draft(draftId); this.assertManagement(owner, draft.ontologyId, admin);
    if (draft.status !== 'open' || draft.revision !== expectedRevision) return conflict('Draft is not open at the expected revision');
    const ref = draft.document.pipeline?.find(value => value.serviceId === serviceId);
    if (!ref) throw new DomainError('NOT_FOUND', 'Service intake is not attached to this draft');
    return { draft, ref, model: compiledModel(draft.document, this.registry) };
  }
  validatePipeline(owner: string, draftId: string, expectedRevision: number, serviceId: string, expiresAt: string, admin = false) {
    return this.transaction(() => {
      const { draft, ref, model } = this.pipelineDraft(owner, draftId, expectedRevision, serviceId, admin);
      return this.pipeline.validate(draft.ontologyId, owner, ref, model, expiresAt);
    });
  }
  putResource(owner: string, draftId: string, expectedRevision: number, kindInput: DefinitionKind, input: unknown, admin = false): DefinitionDraft {
    const kind = definitionKindSchema.parse(kindInput);
    return this.transaction(() => {
      const draft = this.draft(draftId); this.assertManagement(owner, draft.ontologyId, admin);
      if (draft.status !== 'open' || draft.revision !== expectedRevision) return conflict('Draft is not open at the expected revision');
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Definition must be an object');
      const candidate = structuredClone(input) as Record<string, unknown>;
      const old = entries(draft.document).find(value => value.kind === kind && (value.definition.resourceId === candidate.resourceId || value.definition.id === candidate.id));
      candidate.resourceId ??= old?.definition.resourceId ?? `resource:${randomUUID()}`;
      if (old && (candidate.resourceId !== old.definition.resourceId || candidate.id !== old.definition.id)) conflict('Definition identity cannot be renamed in place');
      if (!old && /^(?:builtin:|generated:)/.test(String(candidate.resourceId))) invalid('Reserved definition identity');
      const document = structuredClone(draft.document), list = document[tableKey[kind]] as DefinitionResource[];
      if (old) list[list.findIndex(value => value.resourceId === old.definition.resourceId)] = candidate as unknown as DefinitionResource;
      else list.push(candidate as unknown as DefinitionResource);
      draft.document = parseOntologyDocument(document);
      this.event(draft.ontologyId, owner, 'definition_edited', { draftId, kind, resourceId: candidate.resourceId });
      return this.saveDraft(draft, expectedRevision);
    });
  }
  retireResource(owner: string, draftId: string, expectedRevision: number, resourceId: string, admin = false): DefinitionDraft {
    return this.transaction(() => {
      const draft = this.draft(draftId); this.assertManagement(owner, draft.ontologyId, admin);
      if (draft.status !== 'open' || draft.revision !== expectedRevision) return conflict('Draft is not open at the expected revision');
      const resource = entries(draft.document).find(value => value.definition.resourceId === resourceId);
      if (!resource) throw new DomainError('NOT_FOUND', 'Definition resource is not available');
      if (this.registry.isProtected(resourceId) || resourceId.startsWith('generated:')) throw new DomainError('FORBIDDEN', 'Trusted kernel definitions cannot be retired through a business draft');
      const list = draft.document[tableKey[resource.kind]] as DefinitionResource[];
      list.splice(list.findIndex(value => value.resourceId === resourceId), 1);
      if (resource.kind === 'object') draft.document.links = draft.document.links.filter(link => !(link.resourceId.startsWith('generated:execution-link:') && (link.from.type === resource.definition.id || link.to.type === resource.definition.id)));
      this.event(draft.ontologyId, owner, 'definition_retired_in_draft', { draftId, resourceId }); return this.saveDraft(draft, expectedRevision);
    });
  }
  changes(draft: DefinitionDraft): DefinitionChange[] {
    const before = new Map(entries(this.resolve(draft.base).document).map(entry => [entry.definition.resourceId, entry]));
    const after = new Map(entries(draft.document).map(entry => [entry.definition.resourceId, entry]));
    return [...new Set([...before.keys(), ...after.keys()])].flatMap(resourceId => {
      const old = before.get(resourceId), next = after.get(resourceId), item = next ?? old!;
      if (old && next && digest(old.definition) === digest(next.definition)) return [];
      const fields = old && next ? [...new Set([...Object.keys(old.definition), ...Object.keys(next.definition)])].filter(key => digest((old.definition as unknown as Record<string, unknown>)[key] ?? null) !== digest((next.definition as unknown as Record<string, unknown>)[key] ?? null)) : [];
      return [{ kind: item.kind, resourceId, id: item.definition.id, change: !old ? 'added' as const : !next ? 'retired' as const : 'modified' as const, fields }];
    });
  }
  validate(draftId: string): DefinitionValidation {
    const draft = this.draft(draftId), issues: DefinitionValidation['issues'] = [];
    if (draft.status !== 'open') issues.push({ code: 'draft_closed', message: 'Only an open draft can be validated for publication' });
    let document = draft.document, unboundSourceFields: DefinitionValidation['unboundSourceFields'] = [], migrationRequired = false;
    try {
      document = normalizeOntologyDocument(document);
      const model = compiledModel(document, this.registry), base = this.resolve(draft.base);
      issues.push(...this.pipeline.validateDocument(document, model));
      if (document.actions.some(action => action.implementation?.kind === 'declarative') && !model.properties('Authorization').environment?.schema.safeParse('managed').success) {
        issues.push({ code: 'incompatible_kernel', message: 'Declarative actions require a kernel supporting managed authorization; activate a compatible current kernel before publishing these actions' });
      }
      unboundSourceFields = validateBusinessDefinitionExtensions(base.document, document).unboundSourceFields;
      for (const change of this.changes({ ...draft, document })) {
        const lock = this.db.prepare('SELECT * FROM ontology_definition_names WHERE ontology_id=? AND category=? AND api_name=?').get(draft.ontologyId, category(change.kind), change.id);
        if (lock && (lock.resource_id !== change.resourceId || lock.kind !== change.kind)) issues.push({ code: 'identity_conflict', message: `Published API identity ${change.id} cannot be reused` });
        else if (lock && change.change === 'added') {
          const restored = document.links.find(link => link.resourceId === change.resourceId);
          const canonicalGeneratedLink = change.kind === 'link' && change.resourceId.startsWith('generated:execution-link:') && restored
            && this.db.prepare('SELECT 1 FROM ontology_definition_revisions WHERE ontology_id=? AND resource_id=? AND kind=? AND digest=?').get(draft.ontologyId, change.resourceId, 'link', digest(restored));
          if (!canonicalGeneratedLink) issues.push({ code: 'retired_identity', message: `Retired API identity ${change.id} cannot be reintroduced by editing; activate a compatible historical release instead` });
        }
        if (change.kind === 'object' && change.change !== 'added') {
          const oldType = base.model.object(change.id), next = document.objects.find(value => value.id === change.id);
          const changedIdentity = !!next && (next.primaryKey !== oldType.primaryKey || next.titleKey !== oldType.titleKey);
          const rows = this.instanceRows(draft.ontologyId, change.id);
          if (changedIdentity || rows.overflow) migrationRequired = true;
          for (const row of rows.items) {
            if (!next) { migrationRequired = true; break; }
            const properties = JSON.parse(String(row.body)).properties;
            try { if (digest(model.parseProperties(change.id, properties)) !== digest(properties)) migrationRequired = true; }
            catch { migrationRequired = true; }
          }
          // Narrowing or source/authority changes need an explicit migration
          // even if today's sample has no violating value.
          if (next && !this.additiveObject(base.document.objects.find(value => value.id === change.id)!, next)) migrationRequired = true;
        }
        if (change.kind === 'link' && change.change !== 'added') {
          const next = document.links.find(value => value.id === change.id), old = base.document.links.find(value => value.id === change.id)!;
          if (next ? digest({ from: old.from, to: old.to, writePolicy: old.writePolicy }) !== digest({ from: next.from, to: next.to, writePolicy: next.writePolicy }) : this.linkRows(draft.ontologyId, change.id).length > 0) migrationRequired = true;
        }
        if (change.kind === 'interface' && change.change === 'modified') {
          const old = base.document.interfaces.find(value => value.id === change.id)!, next = document.interfaces.find(value => value.id === change.id)!;
          if (!this.additiveInterface(old, next)) migrationRequired = true;
        }
        if (change.change === 'retired' && this.hasInflightTasks(draft.ontologyId)) migrationRequired = true;
      }
      if (migrationRequired) issues.push({ code: 'migration_required', message: 'This change narrows, retires or changes existing identity/data semantics; supply an explicit compatible migration before activation' });
      const namespace = this.namespace(draft.ontologyId);
      if (namespace.generation !== draft.baseGeneration || digest(namespace.active) !== digest(draft.base)) issues.push({ code: 'base_changed', message: 'Active ontology changed; create a fresh draft and resolve the diff' });
    } catch (error) { issues.push({ code: 'invalid_definition', message: error instanceof Error ? error.message : 'Definition validation failed' }); }
    return { valid: !issues.length && draft.status === 'open', draftId, revision: draft.revision, documentDigest: digest(document), changes: this.changes({ ...draft, document }), issues, migrationRequired, unboundSourceFields,
      counts: { objects: document.objects.length, interfaces: document.interfaces.length, links: document.links.length, actions: document.actions.length } };
  }
  private additiveObject(old: SerializableObjectType, next: SerializableObjectType): boolean {
    if (old.id !== next.id || old.resourceId !== next.resourceId || old.primaryKey !== next.primaryKey || old.titleKey !== next.titleKey || old.writePolicy !== next.writePolicy || digest(old.interfaces ?? []) !== digest(next.interfaces ?? [])) return false;
    if (Object.entries(old.properties).some(([key, property]) => !next.properties[key] || digest(property) !== digest(next.properties[key]))) return false;
    return Object.entries(next.properties).filter(([key]) => !Object.hasOwn(old.properties, key)).every(([, property]) => !property.required && !property.derived);
  }
  private additiveInterface(old: SerializableInterface, next: SerializableInterface): boolean {
    if (digest(old.parents ?? []) !== digest(next.parents ?? [])) return false;
    if (Object.entries(old.properties).some(([name, property]) => !next.properties[name] || digest(property) !== digest(next.properties[name]) || (old.optionalProperties ?? []).includes(name) !== (next.optionalProperties ?? []).includes(name))) return false;
    if (Object.keys(next.properties).some(name => !Object.hasOwn(old.properties, name) && !(next.optionalProperties ?? []).includes(name))) return false;
    for (const key of ['links', 'actions'] as const) {
      const identity = (item: { name?: string; id?: string }) => item.name ?? item.id;
      if ((old[key] ?? []).some(item => !(next[key] ?? []).some(candidate => identity(candidate) === identity(item) && digest(candidate) === digest(item)))) return false;
      if ((next[key] ?? []).some(item => !(old[key] ?? []).some(previous => identity(previous) === identity(item)) && !item.optional)) return false;
    }
    return true;
  }
  private instanceRows(ontologyId: string, type: string): { items: Record<string, unknown>[]; overflow: boolean } {
    const scoped = ontologyId !== DEFAULT_ONTOLOGY, table = scoped ? 'ontology_scoped_objects' : 'ontology_objects';
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return { items: [], overflow: false };
    const rows = this.db.prepare(`SELECT o.body,o.definition_digest FROM ${table} o WHERE ${scoped ? 'o.ontology_id=? AND ' : ''}o.type=? AND NOT EXISTS (SELECT 1 FROM ontology_tombstones t WHERE t.ontology_id=? AND t.owner=o.owner AND t.type=o.type AND t.id=o.id) LIMIT 10001`).all(...(scoped ? [ontologyId, type, ontologyId] : [type, ontologyId]));
    return { items: rows.slice(0, 10000), overflow: rows.length > 10000 };
  }
  private linkRows(ontologyId: string, type?: string): Record<string, unknown>[] {
    const scoped = ontologyId !== DEFAULT_ONTOLOGY, table = scoped ? 'ontology_scoped_links' : 'ontology_links';
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
    return this.db.prepare(`SELECT DISTINCT l.type,l.definition_digest FROM ${table} l WHERE ${scoped ? 'l.ontology_id=? AND ' : ''}${type ? 'l.type=? AND ' : ''}NOT EXISTS (SELECT 1 FROM ontology_tombstones t WHERE t.ontology_id=? AND t.owner=l.owner AND ((t.type=l.from_type AND t.id=l.from_id) OR (t.type=l.to_type AND t.id=l.to_id))) LIMIT 10001`).all(...[...(scoped ? [ontologyId] : []), ...(type ? [type] : []), ontologyId]);
  }
  private hasInflightTasks(ontologyId: string): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) return false;
    return !!this.db.prepare(`SELECT 1 FROM jobs WHERE state NOT IN ('completed','canceled','rejected','failed') AND COALESCE(json_extract(body,'$.delegation.ontologyRelease.ontologyId'),'eigos.business')=? LIMIT 1`).get(ontologyId);
  }
  private assertActivationFacts(release: ResolvedOntologyRelease): void {
    const id = release.ref.ontologyId, scoped = id !== DEFAULT_ONTOLOGY, table = scoped ? 'ontology_scoped_objects' : 'ontology_objects';
    const hasObjects = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const types = hasObjects ? this.db.prepare(`SELECT DISTINCT o.type FROM ${table} o WHERE ${scoped ? 'o.ontology_id=? AND ' : ''}NOT EXISTS (SELECT 1 FROM ontology_tombstones t WHERE t.ontology_id=? AND t.owner=o.owner AND t.type=o.type AND t.id=o.id) LIMIT 2001`).all(...(scoped ? [id, id] : [id])) : [];
    if (types.length > 2000) return conflict('Activation data compatibility needs an explicit bounded migration');
    for (const row of types) {
      const type = String(row.type), rows = this.instanceRows(id, type);
      if (rows.overflow) return conflict('Activation data compatibility needs an explicit bounded migration');
      try {
        const currentDigest = release.model.fingerprint(type);
        for (const item of rows.items) {
          const properties = JSON.parse(String(item.body)).properties, storedDigest = String(item.definition_digest);
          if (digest(release.model.parseProperties(type, properties)) !== digest(properties)
            || storedDigest !== currentDigest && !release.compatibleDefinition({ kind: 'object', id: type, storedDigest, currentDigest, properties })) return conflict('Activation would reinterpret existing facts');
        }
      } catch { return conflict(`Activation requires a data migration for ${type}`); }
    }
    const links = this.linkRows(id);
    if (links.length > 10000) return conflict('Activation link compatibility needs an explicit bounded migration');
    for (const row of links) {
      const type = String(row.type), storedDigest = String(row.definition_digest);
      try {
        const currentDigest = digest(release.model.link(type));
        if (storedDigest !== currentDigest && !release.compatibleDefinition({ kind: 'link', id: type, storedDigest, currentDigest })) return conflict('Activation would reinterpret existing relationships');
      } catch { return conflict(`Activation requires a relationship migration for ${type}`); }
    }
  }
  publish(owner: string, draftId: string, expectedRevision: number, admin = false): { release: OntologyReleaseRef; draft: Omit<DefinitionDraft, 'document'> } {
    return this.transaction(() => {
      const draft = this.draft(draftId); this.assertManagement(owner, draft.ontologyId, admin);
      if (draft.status === 'published' && draft.published && draft.revision === expectedRevision + 1) {
        const { document: _document, ...summary } = draft; return { release: draft.published, draft: summary };
      }
      if (draft.status !== 'open' || draft.revision !== expectedRevision) return conflict('Draft is not open at the expected revision');
      const validation = this.validate(draftId); if (!validation.valid) return conflict(validation.issues.map(issue => issue.message).join('; '));
      const sequence = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ontology_definition_releases WHERE ontology_id=?').get(draft.ontologyId)!.next);
      draft.document = normalizeOntologyDocument({ ...draft.document, version: `release-${sequence}` });
      const release = this.insertRelease(draft.document, owner, draft.base);
      draft.status = 'published'; draft.published = { ...release.ref };
      const saved = this.saveDraft(draft, expectedRevision), { document: _document, ...summary } = saved;
      this.event(draft.ontologyId, owner, 'published', { draftId, release: release.ref }); return { release: release.ref, draft: summary };
    });
  }
  activate(owner: string, ref: OntologyReleaseRef, expectedGeneration: number, admin = false): OntologyNamespace {
    return this.transaction(() => {
      this.assertManagement(owner, ref.ontologyId, admin); const release = this.resolve(ref), namespace = this.namespace(ref.ontologyId);
      if (digest(namespace.active) === digest(ref) && [expectedGeneration, expectedGeneration + 1].includes(namespace.generation)) return namespace;
      if (namespace.generation !== expectedGeneration) return conflict('Active ontology generation changed');
      const historical = this.db.prepare('SELECT 1 FROM ontology_definition_promotions WHERE ontology_id=? AND release_id=?').get(ref.ontologyId, ref.releaseId);
      const lineage = this.db.prepare('SELECT base_ref FROM ontology_definition_lineage WHERE ontology_id=? AND release_id=?').get(ref.ontologyId, ref.releaseId);
      if (!historical && (!lineage?.base_ref || digest(JSON.parse(String(lineage.base_ref))) !== digest(namespace.active))) return conflict('Published release base changed; publish a fresh reviewed draft before activation');
      const current = this.resolve(namespace.active);
      for (const prior of current.document.pipeline ?? []) this.assertPipelineIdentity(ref.ontologyId, prior, release.document.pipeline?.find(next => next.serviceId === prior.serviceId));
      const pipelineIssues = this.pipeline.validateDocument(release.document, release.model);
      if (pipelineIssues.length) return conflict(pipelineIssues.map(issue => issue.message).join('; '));
      const nextIdentities = new Set(entries(release.document).map(item => item.definition.resourceId));
      if (entries(current.document).some(item => !nextIdentities.has(item.definition.resourceId)) && this.hasInflightTasks(ref.ontologyId)) return conflict('Retiring definitions used by in-flight tasks requires a migration');
      // Facts can change after publication, and rollback can omit newer types.
      // Verify every current active type and relation against its writer version.
      this.assertActivationFacts(release);
      const changed = this.db.prepare('UPDATE ontology_namespaces SET active_release_id=?,generation=generation+1 WHERE id=? AND generation=?').run(ref.releaseId, ref.ontologyId, expectedGeneration);
      if (changed.changes !== 1) return conflict('Active ontology generation changed');
      this.recordPromotion(ref);
      this.event(ref.ontologyId, owner, 'activated', { from: namespace.active, to: ref, generation: expectedGeneration + 1 }); return this.namespace(ref.ontologyId);
    });
  }
  discard(owner: string, draftId: string, expectedRevision: number, admin = false): Omit<DefinitionDraft, 'document'> {
    return this.transaction(() => {
      const draft = this.draft(draftId); this.assertManagement(owner, draft.ontologyId, admin);
      if (draft.status !== 'open' || draft.revision !== expectedRevision) return conflict('Draft is not open at the expected revision');
      draft.status = 'discarded'; const { document: _document, ...summary } = this.saveDraft(draft, expectedRevision);
      this.event(draft.ontologyId, owner, 'draft_discarded', { draftId }); return summary;
    });
  }
  releases(ontologyId: string) {
    return this.releasePage(ontologyId, { limit: 100, offset: 0 }).items;
  }
  releasePage(ontologyId: string, page: { limit: number; offset: number }) {
    const { limit, offset } = this.pagination(page);
    const total = Number(this.db.prepare('SELECT count(*) AS count FROM ontology_definition_releases WHERE ontology_id=?').get(ontologyId)!.count);
    const items = this.db.prepare('SELECT id,sequence,digest,model_digest,created_at FROM ontology_definition_releases WHERE ontology_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?').all(ontologyId, limit, offset)
      .map(row => ({ ref: { ontologyId, releaseId: String(row.id), digest: String(row.digest) }, sequence: Number(row.sequence), modelDigest: String(row.model_digest), createdAt: String(row.created_at) }));
    return { items, total, page: { limit, offset, hasMore: offset + items.length < total } };
  }
  events(ontologyId: string, limit = 50) {
    return this.db.prepare('SELECT id,actor,kind,body,at FROM ontology_definition_events WHERE ontology_id=? ORDER BY rowid DESC LIMIT ?').all(ontologyId, Math.max(1, Math.min(100, limit)))
      .map(row => ({ id: String(row.id), actor: String(row.actor), kind: String(row.kind), data: JSON.parse(String(row.body)), at: String(row.at) }));
  }
}
