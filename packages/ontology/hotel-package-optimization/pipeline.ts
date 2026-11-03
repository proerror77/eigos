import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { businessTransaction } from '../../core/transaction.js';
import { DefinitionStore } from '../definition-store.js';
import { resourceIdSchema } from '../definition-contracts.js';
import { OntologyObjectStore } from '../object-store.js';
import type { ObjectRef } from '../model.js';
import { PipelineFactStore } from '../pipeline/facts.js';
import { mapPipelineFields, mapPipelineObservation } from '../pipeline/mapping.js';
import { parsePipelineIntake, type PipelineIntake, type PipelineMapping, type PipelineObservation } from '../pipeline/contracts.js';
import { PACKAGE_STUDY_ONTOLOGY } from './model.js';
import { packagePipelineObjects, packagePipelineLinks, packagePipelineAction } from './pipeline-model.js';
import { refKey, type PipelineStudyContext } from './graph.js';
import { optimizeSyntheticHotelPackages } from './search.js';
import { verifySyntheticHotelPackagePlan } from './verify.js';
import { syntheticPackageFeed } from './pipeline-fixture.js';
import type { Bounds, OptimizationResult } from './contracts.js';

const rowSchema = z.strictObject({ mappingId: resourceIdSchema, eventId: z.string().min(1).max(200),
  providerVersion: z.number().int().nonnegative(), payload: z.record(z.string(), z.unknown()) });
const feedSchema = z.strictObject({ format: z.literal('eigos.synthetic.hotel-package-feed.v1'), environment: z.literal('synthetic'),
  sourceId: resourceIdSchema, sourceAccount: resourceIdSchema, sourceRevision: z.literal('1'), observedAt: z.iso.datetime({ offset: true }),
  rows: z.array(rowSchema).min(1).max(200) });
export type SyntheticPackageFeed = z.infer<typeof feedSchema>;
export type SyntheticPackageRow = SyntheticPackageFeed['rows'][number];
type Relationship = NonNullable<PipelineMapping['links']>[number];
const relationship = (linkType: string, targetMapping: string, field: string, many = false, optional = false): Relationship =>
  ({ linkType, targetMapping, nativeId: ['relations', field], many, optional });

/** Fixed reviewed field/relationship bindings. Payloads cannot supply mappings,
 * primary keys, executable expressions or arbitrary cross-source references. */
export function packagePipelineMappings(): PipelineMapping[] {
  const mapping = (id: string, objectType: string, fields: [string, string][], links: Relationship[] = []): PipelineMapping => ({
    id, objectType, nativeId: ['sourceKey'], maxAgeMs: 3600000,
    fields: [{ from: ['label'], to: ['displayTitle'], optional: false }, ...fields.map(([from, to]) => ({ from: [from], to: [to], optional: false }))], links,
  });
  const data = (id: string, type: string, from: string, links: Relationship[] = []) => mapping(id, type, [[from, 'data']], links);
  return [
    mapping('hotel', 'HotelProperty', [['sourceKey', 'sourceId'], ['hotel_name', 'hotelName'], ['address', 'address'], ['timezone', 'timeZone']]),
    mapping('room', 'RoomType', [['sourceKey', 'sourceId'], ['room_name', 'roomTypeName'], ['hotel_key', 'hotelId'], ['max_adults', 'maximumAdults'],
      ['max_children', 'maximumChildren'], ['capacity', 'guestCapacity'], ['bed', 'bedDescription']], [relationship('RoomTypeHotel', 'hotel', 'hotel')]),
    mapping('rate', 'HotelRatePlan', [['sourceKey', 'sourceId'], ['revision', 'sourceRevision'], ['hotel_key', 'hotelId'], ['room_key', 'roomTypeId']],
      [relationship('HotelRatePlanHotel', 'hotel', 'hotel'), relationship('HotelRatePlanRoomType', 'room', 'room')]),
    data('product', 'PackageProduct', 'product'),
    mapping('variant', 'ProductVariant', [['label', 'name'], ['product_ref', 'sourceProductRef'], ['specification', 'specification'], ['revision', 'specificationRevision']],
      [relationship('PackageVariantProduct', 'product', 'product')]),
    data('entitlement', 'PackageEntitlement', 'meaning'),
    data('component', 'PackageComponent', 'terms', [relationship('PackageComponentRoomTypes', 'room', 'rooms', true, true),
      relationship('PackageComponentRatePlan', 'rate', 'rate', false, true), relationship('PackageComponentEntitlement', 'entitlement', 'entitlement', false, true)]),
    data('prerequisite', 'PackagePrerequisite', 'rule', [relationship('PackagePrerequisiteSku', 'sku', 'sku')]),
    data('sku', 'PackageSkuSpecification', 'spec', [relationship('PackageSkuVariant', 'variant', 'variant'),
      relationship('PackageSkuComponents', 'component', 'components', true), relationship('PackageSkuPrerequisites', 'prerequisite', 'prerequisites', true)]),
    data('pool', 'PackageInventoryPool', 'stock', [relationship('PackagePoolRoomTypes', 'room', 'rooms', true),
      relationship('PackagePoolSkus', 'sku', 'skus', true), relationship('PackagePoolEntitlement', 'entitlement', 'entitlement', false, true)]),
    data('use', 'PackageResourceUse', 'use', [relationship('PackageUsePool', 'pool', 'pool'), relationship('PackageUseComponent', 'component', 'component', false, true)]),
    data('quote', 'PackageDatedQuote', 'pricing', [relationship('PackageQuoteSku', 'sku', 'sku'), relationship('PackageQuoteRoomType', 'room', 'room', false, true),
      relationship('PackageQuoteUses', 'use', 'uses', true)]),
    data('study', 'HotelPackageStudy', 'catalog', [relationship('PackageStudyProducts', 'product', 'products', true), relationship('PackageStudySkus', 'sku', 'skus', true),
      relationship('PackageStudyQuotes', 'quote', 'quotes', true), relationship('PackageStudyPools', 'pool', 'pools', true), relationship('PackageStudyEntitlements', 'entitlement', 'entitlements', true)]),
    data('request', 'HotelPackageRequest', 'requirements', [relationship('PackageRequestStudy', 'study', 'study'), relationship('PackageRequestHotel', 'hotel', 'hotel'),
      relationship('PackageRequestRoomTypes', 'room', 'rooms', true)]),
  ];
}

function intakeFor(feed: SyntheticPackageFeed, actionDigest: string): PipelineIntake {
  const mappings = packagePipelineMappings(), examples = syntheticPackageFeed('qualification');
  return parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: 'synthetic.hotel-package-mapping',
    source: { id: feed.sourceId, revision: feed.sourceRevision, digest: digest({ format: feed.format, revision: feed.sourceRevision, mappings }),
      observedAt: feed.observedAt, reference: 'urn:eigos:synthetic:hotel-package-feed-v1' },
    programRef: { id: 'synthetic.hotel-package-study', version: '1' }, configurationDigest: digest({ mode: 'synthetic-only', mappings }), environment: 'sandbox',
    vocabulary: [{ term: '套餐 SKU', aliases: ['可购买规格'], objectType: 'ProductVariant' }, { term: '日期报价', aliases: [], objectType: 'PackageDatedQuote' }],
    // A modeling declaration, not fabricated Worker/task evidence or live readiness.
    actions: [{ actionId: packagePipelineAction.id, definitionDigest: actionDigest, requiredEvidence: 'definition_only' }],
    mappings, fixtures: mappings.map(mapping => {
      const example = examples.rows.find(row => row.mappingId === mapping.id)!;
      return { mappingId: mapping.id, input: example.payload, expected: mapPipelineFields(mapping, example.payload) };
    }), conditions: { regions: [], payment: 'not_required', operatorRequired: false },
  });
}

/** A real DefinitionStore → validated/published intake → PipelineFactStore
 * import, confined to one :memory: database and the synthetic namespace. */
export function createSyntheticPackagePipeline(raw: unknown, options: { now?: string; owner?: string } = {}) {
  const feed = feedSchema.parse(raw), db = new DatabaseSync(':memory:');
  let clock = Date.parse(options.now ?? '2030-01-01T00:00:00Z');
  if (!Number.isFinite(clock)) { db.close(); throw new Error('Invalid synthetic study clock'); }
  const now = () => clock, owner = options.owner ?? 'synthetic-package-pipeline-owner';
  try {
    const definitions = new DefinitionStore(db, now);
    const namespace = definitions.createNamespace(owner, { id: PACKAGE_STUDY_ONTOLOGY, name: 'Synthetic hotel-package pipeline' });
    let draft = definitions.createDraft(owner, namespace.id, 'Synthetic SKU mapping and optimization');
    for (const object of packagePipelineObjects) draft = definitions.putResource(owner, draft.id, draft.revision, 'object', object);
    for (const link of packagePipelineLinks) draft = definitions.putResource(owner, draft.id, draft.revision, 'link', link);
    draft = definitions.putResource(owner, draft.id, draft.revision, 'action', packagePipelineAction);
    const { resourceId: _id, ...action } = packagePipelineAction;
    const intake = intakeFor(feed, digest(action));
    draft = definitions.putPipeline(owner, draft.id, draft.revision, intake);
    const validation = definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, new Date(now() + 3600000).toISOString());
    if (!validation.valid) throw new Error(`Package mapping validation failed: ${validation.issues.join('; ')}`);
    const release = definitions.publish(owner, draft.id, draft.revision).release;
    definitions.activate(owner, release, namespace.generation);
    const published = definitions.resolve(release), intakeRef = published.document.pipeline!.find(p => p.serviceId === intake.serviceId)!;
    const graph = new OntologyObjectStore(db, published.model, now, undefined, { ontologyId: namespace.id, releaseRef: release, skipLegacyMigration: true });
    // PipelineFactStore's dependency query expects the shared jobs table. This
    // test host has no jobs/Worker; the table stays empty and grants no authority.
    db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL)');
    const facts = new PipelineFactStore(db, { active: () => false, changed: () => { throw new Error('A synthetic study must not schedule a task'); } }, now);
    function assertCurrent() {
      if (digest(definitions.namespace(namespace.id).active) !== digest(release)
        || definitions.pipeline.validateIntake(namespace.id, intakeRef, graph.model).length) throw new Error('Published synthetic mapping validation is not current');
    }
    const context: PipelineStudyContext = { facts, intakeDigest: intakeRef.intakeDigest, sourceId: feed.sourceId, assertCurrent };
    function observation(current: SyntheticPackageFeed, row: SyntheticPackageRow): PipelineObservation {
      return { eventId: row.eventId, sourceAccount: current.sourceAccount, sourceRevision: current.sourceRevision, sourceDigest: intake.source.digest,
        providerVersion: row.providerVersion, observedAt: current.observedAt, receivedAt: new Date(now()).toISOString(), evidenceLevel: 'synthetic',
        evidenceRefs: [`synthetic:package-feed:${digest({ row, source: current.sourceId, account: current.sourceAccount })}`], payload: row.payload };
    }
    function preview(current: SyntheticPackageFeed, row: SyntheticPackageRow) {
      const mapping = intake.mappings.find(m => m.id === row.mappingId);
      if (!mapping) throw new Error('Unknown package source mapping');
      return mapPipelineObservation(graph.model, owner, intake, mapping, observation(current, row), now());
    }
    function ingest(rawFeed: unknown) {
      const current = feedSchema.parse(rawFeed); assertCurrent();
      if (current.sourceId !== feed.sourceId || current.sourceAccount !== feed.sourceAccount || current.sourceRevision !== feed.sourceRevision) throw new Error('Synthetic source/account/contract changed');
      const pending = current.rows.map(row => ({ row, mapped: preview(current, row) })), seen = new Set<string>();
      for (const entry of pending) {
        const key = refKey(entry.mapped.ref);
        if (seen.has(key)) throw new Error('Duplicate source-native object in one feed');
        seen.add(key);
      }
      // Determine dependency order before writes. Missing relationships and
      // cycles fail atomically; payload array order never establishes identity.
      const ready = new Set<string>(), ordered: typeof pending = [];
      while (pending.length) {
        const index = pending.findIndex(entry => (entry.mapped.links ?? []).every(link => ready.has(refKey(link.to))
          || !seen.has(refKey(link.to)) && facts.current(owner, namespace.id, link.to)?.health === 'fresh'));
        if (index < 0) throw new Error('Package feed has unresolved relationships or a dependency cycle');
        const [entry] = pending.splice(index, 1); ordered.push(entry!); ready.add(refKey(entry!.mapped.ref));
      }
      return businessTransaction(db, () => ordered.map(({ row, mapped }) => {
        const previous = facts.current(owner, namespace.id, mapped.ref);
        return { mappingId: row.mappingId, nativeId: String(row.payload.sourceKey), ...facts.apply(owner, graph, intake, intakeRef.intakeDigest,
          row.mappingId, observation(current, row), previous?.revision ?? 0) };
      }));
    }
    const imported = ingest(feed);
    function ref(mappingId: string, nativeId: string): ObjectRef {
      const mapping = intake.mappings.find(m => m.id === mappingId);
      if (!mapping) throw new Error('Unknown mapping');
      return { type: mapping.objectType, id: `pipeline:${digest({ owner, source: feed.sourceId, account: feed.sourceAccount, type: mapping.objectType, nativeId })}` };
    }
    function optimize(requestId = 'request', bounds: Partial<Bounds> = {}) {
      return optimizeSyntheticHotelPackages(graph, owner, ref('request', requestId), bounds, context);
    }
    function verify(result: OptimizationResult) { return verifySyntheticHotelPackagePlan(graph, owner, result, context); }
    return { graph, owner, definitions, facts, intake, release, validation, imported, context, ref, ingest, optimize, verify,
      advance: (milliseconds: number) => { if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid time advance'); clock += milliseconds; },
      mappingSummary: { evidenceLevel: 'synthetic' as const, materialDigest: digest(feed), intakeDigest: intakeRef.intakeDigest,
        release, records: imported.length, mappingIds: intake.mappings.map(m => m.id), mappingValidation: 'passed' as const, executableService: false as const },
      close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}
