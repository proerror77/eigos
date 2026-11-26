import type { CognitiveStep } from './cognitive-workflow.js';
import { scenarioMetadataRead, scenarioMetadataQuery, scenarioMetadataType } from './scenario-metadata.js';
import { observeDecisionRead, observedObject, observedObjects, observedPage } from './decision-evidence.js';
import { DerivedProperties } from './derived.js';
import { compareValues, matchesPredicate, nestedValue, orderSchema, predicateFields, predicateSchema, regexMatches, propertyPathSchema } from './query-filter.js';
import { journalLinks, recordObjectEdit, resolveSourceEdits } from './edit-history.js';
import { z } from 'zod';
import { Conflict, NotFound, PermissionDenied, InvalidInput, digest, type ExecutionActor } from '../core/identity.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectData, type ObjectRef, type LinkData } from '../ontology/schema.js';
import { documentChunkType, documentType } from '../ontology/documents.js';
import { processLogTarget } from '../ontology/process-definition.js';
import { isSandboxResource } from '../ontology/sandbox.js';
import { Database, type Sql } from './database.js';
import { checkScenario, lockEdits, viewTables, stageObject, stageLink, type ScenarioMutation } from './scenario-store.js';
import { isNumeric, storedPredicate, supportsStoredOrder, supportsStoredPredicate, type Metric } from './stored-query.js';

const maxCompleteRelationships = 1_000;

const instant = z.iso.datetime({ offset: true });
const intervalOverlapSchema = z.strictObject({
  start: propertyPathSchema, end: propertyPathSchema,
  from: instant, until: instant, includeUnknown: z.boolean().optional(),
}).refine(input => Date.parse(input.from) < Date.parse(input.until), 'Expected a nonempty time window');

export const querySchema = z.strictObject({
  type: z.string(), where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  filter: predicateSchema.optional(), orderBy: orderSchema.optional(), intervalOverlap: intervalOverlapSchema.optional(),
  select: z.array(propertyPathSchema).max(30).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional(),
  from: z.strictObject({ object: objectRefSchema, link: z.string(), as: z.string().optional() }).optional(),
});
export type Query = z.input<typeof querySchema>;
function decodeQueryCursor(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidInput('Invalid query cursor');
  }
}
export function queryFields(query: Pick<z.output<typeof querySchema>, 'where' | 'filter' | 'orderBy' | 'select' | 'intervalOverlap'>) {
  return [...new Set([...Object.keys(query.where ?? {}), ...predicateFields(query.filter),
    ...(query.orderBy ?? []).map(item => item.property), ...(query.select ?? []),
    ...(query.intervalOverlap ? [query.intervalOverlap.start, query.intervalOverlap.end] : [])])];
}
export class Objects {
  constructor(readonly db: Database, readonly model: PublishedOntology, readonly access: Access, readonly client: Sql = db.pool,
    readonly change?: {
      action?: string; requestId?: string; taskId?: string; inputDigest?: string; reviewedChangeDigest?: string;
      executor?: ExecutionActor; scenarioEdits?: ScenarioMutation[];
      validateWorkflow?: (objects: Objects, validation: CognitiveStep['validation'], object: ObjectRef) => Promise<void>;
    }) {
    if (!db.objectScoped(client)) return;
    // In an object-scoped commit, this graph's Ontology data statements are the ones its object locks cover.
    for (let proto = Object.getPrototypeOf(this); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const method = Object.getOwnPropertyDescriptor(proto, name)?.value;
        if (name === 'constructor' || typeof method !== 'function' || Object.hasOwn(this, name)) continue;
        Object.defineProperty(this, name, { configurable: true, writable: true,
          value: (...args: unknown[]) => db.withObjectAccess(() => method.apply(this, args)) });
      }
    }
  }
  get owner() { return this.access.principal.owner; }
  /** Object-scoped commits lock each object before reading (shared) or writing it or its relationships (exclusive). */
  protected lockObjects(refs: readonly ObjectRef[], mode: 'shared' | 'exclusive') {
    return this.db.lockObjects(this.client, refs.map(ref => this.db.lockKey('object', this.model.projection, this.owner, ref.type, ref.id)), mode);
  }
  /** A read whose conflicts object locks cannot bound sends an object-scoped commit to its exclusive rerun. */
  protected requireExclusive(reason: string) { this.db.requireExclusive(this.client, reason); }
  /**
   * In an object-scoped commit, a read bounded by one source's relationship locks every target of it before
   * reading: the source's shared lock fixes the relationship, and the targets' locks fix what filters see.
   */
  private async lockRelationshipTargets(source: ObjectRef, link: string, view?: string) {
    if (!this.db.objectScoped(this.client)) return;
    const nav = this.model.navigation(source.type, link, view);
    if (processLogTarget(this.model, nav.target)) this.requireExclusive('process log relationship');
    const [from, to] = nav.forward ? ['from', 'to'] : ['to', 'from'];
    const { rows } = await this.db.query(`SELECT l.${to}_type AS type,l.${to}_id AS id FROM ${this.db.schema}.links l
      WHERE l.projection=$1 AND l.owner=$2 AND l.type=$3 AND l.${from}_type=$4 AND l.${from}_id=$5 LIMIT $6`,
      [this.model.projection, this.owner, nav.link, source.type, source.id, this.db.objectLockBudget + 1], this.client);
    await this.lockObjects([source, ...rows.map(row => ({ type: String(row.type), id: String(row.id) }))], 'shared');
  }
  private writeReady?: Promise<void>;
  async lockWrites() { await this.prepareWrite(); }
  private prepareWrite() {
    return this.writeReady ??= (async () => {
      await lockEdits(this.db, this.model, this.owner, this.client);
      await checkScenario(this.db, this.model, this.owner, this.client, true);
    })();
  }
  private assertStoredFields(ref:ObjectRef,properties:Record<string,unknown>) {
    if(Object.keys(properties).some(field=>this.model.object(ref.type).properties[field]?.derived))throw new Conflict('Derived properties are read-only');
  }
  private writeType(type: string, endpoint=false) {
    if (processLogTarget(this.model,type)) throw new Conflict('Process logs and their relationships are read-only');
    if(type===scenarioMetadataType&&!endpoint)throw new Conflict('Edit Scenario metadata through its lifecycle API');
    this.access.definition(this.model, 'object', type);
    for (const source of this.model.sources.values()) if (source.objectType === type) {
      const provider = this.model.functions.get(source.function)?.source;
      if (provider) this.access.source(this.model, provider);
    }
  }
  maskSnapshot(ref: ObjectRef, properties: Record<string, unknown>): Record<string, unknown> | null {
    this.access.read(this.model,ref.type);
    if (!this.access.rowAllowed(this.model,ref.type,properties)) return null;
    this.access.readRow(this.model,ref.type,properties);
    return Object.fromEntries(Object.entries(properties).filter(([field])=>this.model.object(ref.type).properties[field]).map(([field,value])=>[field,this.access.cell(this.model,ref.type,field,properties)?value:null]));
  }
  private visible(object: ObjectData): ObjectData {
    this.access.readRow(this.model,object.ref.type,object.properties);
    return { ...object, properties: this.maskSnapshot(object.ref,object.properties)! };
  }
  private row(row: Record<string, unknown>): ObjectData {
    const ref = { type: String(row.type), id: String(row.id) };
    const properties = this.model.parseObject(ref, row.properties as Record<string, unknown>);
    return { ref, revision: Number(row.revision), properties };
  }
  private async stored(input: ObjectRef): Promise<ObjectData> {
    const ref = objectRefSchema.parse(input);
    if (processLogTarget(this.model, ref.type)) this.requireExclusive('process log read');
    await this.lockObjects([ref], 'shared');
    await checkScenario(this.db, this.model, this.owner, this.client);
    const values: unknown[] = [this.owner, ref.type, ref.id, this.model.projection];
    const policy = ref.type === documentChunkType || processLogTarget(this.model,ref.type) ? this.access.rowSql(this.model,ref.type,values,'o.properties') : 'TRUE';
    const tables = viewTables(this.db, this.model, this.owner, values,[ref.type]);
    const rows = await this.db.readQuery(`${tables.prefix}SELECT type,id,revision,properties FROM ${tables.objects} o WHERE owner=$1 AND type=$2 AND id=$3 AND projection=$4 AND ${policy}`, values, this.client);
    if (!rows.rows[0]) throw new NotFound('Object is unavailable');
    return this.row(rows.rows[0]);
  }
  async readStored(input: ObjectRef): Promise<ObjectData> {
    return observeDecisionRead(this, { kind: 'stored', ref: objectRefSchema.parse(input) },
      () => this.loadStored(input), observedObject);
  }
  private async loadStored(input: ObjectRef): Promise<ObjectData> {
    if(input.type===scenarioMetadataType)return scenarioMetadataRead(this,input);
    this.access.read(this.model, input.type);
    const object = await this.stored(input);
    await this.linkedSecurityReads([object]);
    return this.visible(object);
  }
  private async linkedSecurityReads(objects: ObjectData[]) {
    const seen = new Set<string>();
    for (const object of objects) {
      const log = processLogTarget(this.model, object.ref.type);
      const target = log ? { type: log.objectType, id: String(object.properties.processId), field: log.property }
        : object.ref.type === documentChunkType
          ? { type: documentType, id: String(object.properties.documentId), field: 'extractedText' }
          : undefined;
      if (!target) continue;
      const { field, ...ref } = target, key = JSON.stringify(target);
      if (!seen.has(key)) {
        seen.add(key);
        const parent = await this.stored(ref);
        this.access.readRow(this.model, ref.type, parent.properties, true);
        if (!this.access.cell(this.model, ref.type, field, parent.properties)) throw new NotFound('Linked data is unavailable');
      }
      if (log && this.access.needsEgressRead(this.model, ref.type)) {
        const history = (await this.db.readQuery(`SELECT before_values,after_values FROM ${this.db.schema}.edit_history
          WHERE owner=$1 AND sequence=$2 AND release=$3`, [this.owner, object.properties.sequence, object.properties.release], this.client)).rows[0];
        for (const properties of [history?.before_values, history?.after_values]) {
          if (properties) this.access.observeRowClassification(this.model, ref.type, properties);
        }
      }
    }
  }
  /** Source fields must match their baseline; unrelated local notes may remain. */
  async matchesSource(ref: ObjectRef, sourceName: string): Promise<boolean> {
    return (await observeDecisionRead(this, { kind: 'source', ref, source: sourceName },
      () => this.sourceMatch(ref, sourceName))).matches;
  }
  private async sourceMatch(ref:ObjectRef,sourceName:string) {
    const mapping=this.model.sources.get(sourceName),provider=mapping&&this.model.functions.get(mapping.function)?.source;
    if(!mapping||mapping.objectType!==ref.type||!provider)throw new Error('Source certification requires a matching datasource');
    this.access.source(this.model,provider);
    const object=await this.stored(ref);this.access.readRow(this.model,ref.type,object.properties);
    const baseline = (await this.db.readQuery<{ properties: Record<string, unknown>; observed_at: string }>(
      `SELECT properties,observed_at::text FROM ${this.db.schema}.source_values
        WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND source=$5`,
      [this.model.projection, this.owner, ref.type, ref.id, sourceName], this.client,
    )).rows[0];
    const matches = Boolean(baseline && Object.entries(baseline.properties).every(([field, value]) =>
      Object.hasOwn(object.properties, field) && this.access.cell(this.model, ref.type, field, object.properties)
      && digest(object.properties[field]) === digest(value)));
    return { matches, version: baseline, revision: object.revision };
  }
  /**
   * For objects this graph has read, whether each named property is visible, as propertyVisible decides, from
   * one read. Objects whose rows need a row policy or cannot be read here are left to the per-object check.
   */
  async propertyVisibility(items: readonly { ref: ObjectRef; names: readonly string[] }[]): Promise<Map<string, boolean>> {
    const visibility = new Map<string, boolean>();
    const plain = items.filter(({ ref }) => ref.type !== documentChunkType && !processLogTarget(this.model, ref.type));
    if (!plain.length) return visibility;
    await this.lockObjects(plain.map(item => item.ref), 'shared');
    await checkScenario(this.db, this.model, this.owner, this.client);
    const values: unknown[] = [this.owner, this.model.projection, JSON.stringify(plain.map(({ ref }) => ({ type: ref.type, id: ref.id })))];
    const tables = viewTables(this.db, this.model, this.owner, values, [...new Set(plain.map(({ ref }) => ref.type))]);
    const { rows } = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
      JOIN jsonb_to_recordset($3::jsonb) AS k(type text,id text) ON o.type=k.type AND o.id=k.id
      WHERE o.owner=$1 AND o.projection=$2`, values, this.client);
    const names = new Map(plain.map(item => [digest({ type: item.ref.type, id: item.ref.id }), item.names]));
    for (const row of rows) {
      let object: ObjectData;
      try { object = this.row(row); this.access.readRow(this.model, object.ref.type, object.properties); } catch { continue; }
      for (const name of names.get(digest(object.ref)) ?? [])
        visibility.set(digest([object.ref, name]), this.access.cell(this.model, object.ref.type, name, object.properties));
    }
    return visibility;
  }
  /**
   * The objects linked from each source along one step, as queryStored with `from` returns them for that source,
   * from one read. Undefined when the target type needs the per-source path: it has derived properties, row
   * policies of its own kind, or the relationship is too large to hold at once.
   */
  async linkedTargets(sources: readonly ObjectRef[], link: string, as?: string): Promise<Map<string, ObjectData[]> | undefined> {
    const sourceType = sources[0]?.type;
    if (!sourceType || sources.some(source => source.type !== sourceType) || processLogTarget(this.model, sourceType)) return undefined;
    const nav = this.model.navigation(sourceType, link, as), target = nav.target;
    if (!this.model.objects.has(target) || [scenarioMetadataType, documentChunkType].includes(target) || processLogTarget(this.model, target)
      || Object.values(this.model.object(target).properties).some(property => property.derived)) return undefined;
    // The checks storedSelection makes for each source, made once for the batch.
    await checkScenario(this.db, this.model, this.owner, this.client);
    this.access.definition(this.model, 'object', target);
    if (as) this.access.definition(this.model, 'interface', as);
    this.access.read(this.model, target);
    this.access.definition(this.model, 'link', nav.link);
    const key = (id: string) => digest({ type: sourceType, id });
    const targets = new Map(sources.map(source => [key(source.id), [] as ObjectData[]]));
    const label = this.model.links.get(nav.link)?.classification;
    if (!this.access.canSeeModelData(label)) return targets;
    this.access.observeClassification(label);
    if (!this.access.canRead(this.model, target)) return targets;
    const [from, to] = nav.forward ? ['from', 'to'] : ['to', 'from'], ids = sources.map(source => source.id), limit = 50000;
    if (this.db.objectScoped(this.client)) {
      const { rows } = await this.db.query(`SELECT l.${to}_type AS type,l.${to}_id AS id FROM ${this.db.schema}.links l
        WHERE l.projection=$1 AND l.owner=$2 AND l.type=$3 AND l.${from}_type=$4 AND l.${from}_id=ANY($5::text[]) LIMIT $6`,
        [this.model.projection, this.owner, nav.link, sourceType, ids, this.db.objectLockBudget + 1], this.client);
      await this.lockObjects([...sources, ...rows.map(row => ({ type: String(row.type), id: String(row.id) }))], 'shared');
    }
    const values: unknown[] = [this.owner, this.model.projection];
    const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
    const tables = viewTables(this.db, this.model, this.owner, values, [target, sourceType]);
    const policy = this.access.rowSql(this.model, target, values, 'o.properties');
    const { rows } = await this.db.readQuery(`${tables.prefix}SELECT l.${from}_id AS source_id,o.type,o.id,o.revision,o.properties
      FROM ${tables.links} l JOIN ${tables.objects} o ON o.projection=l.projection AND o.owner=l.owner AND o.type=l.${to}_type AND o.id=l.${to}_id
      WHERE l.owner=$1 AND l.projection=$2 AND l.type=${bind(nav.link)} AND l.${from}_type=${bind(sourceType)}
        AND l.${from}_id=ANY(${bind(ids)}::text[]) AND o.type=${bind(target)} AND ${policy}
      ORDER BY l.${from}_id, o.type COLLATE "C", o.id COLLATE "C" LIMIT ${bind(limit + 1)}`, values, this.client);
    if (rows.length > limit) return undefined;
    const records = rows.map(row => ({ source: String(row.source_id), object: this.row(row) }));
    await this.linkedSecurityReads(records.map(record => record.object));
    const fields = Object.keys(this.model.object(target).properties);
    for (const { source, object } of records) {
      this.access.readRow(this.model, object.ref.type, object.properties);
      targets.get(key(source))?.push({ ...object, properties: Object.fromEntries(fields.map(field => [field,
        this.visibleViewField(target, field) && this.access.cell(this.model, object.ref.type, field, object.properties) ? object.properties[field] : null])) });
    }
    return targets;
  }
  async propertyVisible(ref:ObjectRef,field:string):Promise<boolean> {
    const object=await this.stored(ref);
    this.access.readRow(this.model,ref.type,object.properties);
    return this.access.cell(this.model,ref.type,field,object.properties);
  }
  async read(input: ObjectRef): Promise<ObjectData> {
    return observeDecisionRead(this, { kind: 'object', ref: objectRefSchema.parse(input) }, () => this.readObject(input), observedObject);
  }
  private async readObject(input: ObjectRef): Promise<ObjectData> {
    if(this.client===this.db.pool&&Object.values(this.model.object(input.type).properties).some(property=>property.derived)) {
      const access=await this.access.fork();
      const result=await this.db.transaction(async client=>{
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
        return new Objects(this.db,this.model,access,client).read(input);
      });
      if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Derived result permissions changed');
      this.access.adoptReads(access);return result;
    }
    return new DerivedProperties(this).enrich(await this.readStored(input));
  }
  async query(input: Query): Promise<{ items: ObjectData[]; cursor?: string }> {
    this.requireExclusive('set query');
    const args = querySchema.parse(input);
    return observeDecisionRead(this, { kind: 'query', input: args }, () => this.queryObjects(args), observedPage);
  }
  /**
   * Every match of a query for a caller that needs the whole set, such as Object Set evaluation. A query that
   * needs complete evaluation (derived properties, filters, ordering) is evaluated once rather than once per
   * page; other queries are read page by page from storage.
   */
  async queryAll(input: Query): Promise<ObjectData[]> {
    this.requireExclusive('set query');
    const args = querySchema.parse({ ...input, limit: 100, cursor: undefined });
    const items: ObjectData[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.queryObjects({ ...args, cursor }, true);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return items;
  }
  private async queryObjects(args: z.output<typeof querySchema>, complete = false): Promise<{ items: ObjectData[]; cursor?: string }> {
    const fields = queryFields(args);
    this.access.definition(this.model, this.model.interfaces.has(args.type) ? 'interface' : 'object', args.type);
    const viewLabel = this.model.interfaces.get(args.type)?.classification;
    if (!this.access.canSeeModelData(viewLabel)) return { items: [], cursor: undefined };
    this.access.observeClassification(viewLabel);
    const types = this.model.concreteTypes(args.type);
    for (const field of fields) this.model.propertyPath(args.type, field);
    const derived=types.some(type=>Object.values(this.model.object(type).properties).some(property=>property.derived));
    if(!args.filter&&!args.orderBy&&!derived&&!fields.some(field=>field.includes('.')))return this.queryStored(args);
    if(this.client===this.db.pool) {
      const access=await this.access.fork();
      const result=await this.db.transaction(async client=>{
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
        return new Objects(this.db,this.model,access,client).queryObjects(args,complete);
      });
      if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Query permissions changed');
      this.access.adoptReads(access);return result;
    }
    const evaluator = new DerivedProperties(this);
    const definitions = this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties;
    const project = async (raw: ObjectData) => {
      const enriched = await evaluator.enrich(raw);
      const properties = Object.fromEntries(Object.keys(definitions).map(field => {
        const local = this.model.propertyName(raw.ref.type, args.type, field);
        return [field, local && this.visibleViewField(args.type, field) ? enriched.properties[local] ?? null : null];
      }));
      return { ...enriched, properties };
    };
    const pushed = await this.scalarCandidates(args);
    let matching: ObjectData[];
    if (pushed) {
      matching = [];
      await evaluator.prefetch(pushed.objects);
      for (const item of pushed.objects) matching.push(await project(item));
    } else {
      const candidates: ObjectData[] = [], all: ObjectData[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.queryStored({ type: args.type, from: args.from, intervalOverlap: args.intervalOverlap, limit: 100, cursor });
        for (const item of page.items) {
          candidates.push(args.type === item.ref.type ? item : await this.readStored(item.ref));
          if (candidates.length > 10000) throw new Conflict('Extended query exceeds 10000 complete candidate objects');
        }
        cursor = page.cursor;
      } while (cursor);
      // Derived properties of every candidate read their visibility and relationships together.
      await evaluator.prefetch(candidates);
      for (const item of candidates) all.push(await project(item));
      const regex = await regexMatches(args.filter, all);
      matching = all.filter(object => Object.entries(args.where).every(([field, value]) =>
        digest(nestedValue(object.properties, field)) === digest(value)) &&
        (!args.filter || matchesPredicate(args.filter, object.properties, regex)));
    }
    if (!pushed?.ordered) matching.sort((left, right) => {
      for (const order of args.orderBy ?? []) {
        const a = nestedValue(left.properties, order.property);
        const b = nestedValue(right.properties, order.property);
        const comparison = compareValues(a, b);
        if (comparison) return a === null || b === null ? comparison : order.direction === 'desc' ? -comparison : comparison;
      }
      return Buffer.compare(Buffer.from(JSON.stringify(left.ref)), Buffer.from(JSON.stringify(right.ref)));
    });
    const identity=digest({owner:this.owner,release:this.model.release,scenario:this.model.scenario,args:{...args,cursor:undefined,limit:undefined},objects:matching});
    const offset=args.cursor?z.strictObject({query:z.literal(identity),offset:z.number().int().min(0).max(matching.length)}).parse(decodeQueryCursor(args.cursor)).offset:0;
    const end=complete?matching.length:offset+args.limit;
    const items=matching.slice(offset,end).map(object=>args.select?{...object,properties:Object.fromEntries(args.select.map(field=>[field,nestedValue(object.properties,field)]))}:object);
    return {items,cursor:end<matching.length?Buffer.from(JSON.stringify({query:identity,offset:end})).toString('base64url'):undefined};
  }
  private visibleViewField(view: string, field: string) {
    const label = this.model.interfaces.get(view)?.properties[field]?.classification;
    if (!this.access.canSeeModelData(label)) return false;
    this.access.observeClassification(label);
    return true;
  }
  private mayUseStoredFields(view: string, types: string[], fields: string[]) {
    return types.every(type => type !== scenarioMetadataType && !processLogTarget(this.model, type)
      && fields.every(field => {
        const [root, ...nested] = field.split('.');
        if (nested.some(part => /^0[0-9]+$|^[0-9]{10,}$/.test(part))) return false;
        const local = this.model.propertyName(type, view, root!);
        return !local || !this.model.object(type).properties[local]?.derived;
      }));
  }
  private async storedSelection(args: z.output<typeof querySchema>, inlineView = false) {
    await checkScenario(this.db, this.model, this.owner, this.client);
    this.access.definition(this.model, this.model.interfaces.has(args.type) ? 'interface' : 'object', args.type);
    const viewLabel = this.model.interfaces.get(args.type)?.classification;
    if (!this.access.canSeeModelData(viewLabel)) return undefined;
    this.access.observeClassification(viewLabel);
    const navigation = args.from && this.model.navigation(args.from.object.type, args.from.link, args.from.as);
    if (args.from && navigation) {
      if (args.from.as) this.access.definition(this.model, 'interface', args.from.as);
      await this.readStored(args.from.object);
      this.access.read(this.model, navigation.target);
      this.access.definition(this.model, 'link', navigation.link);
      const label = this.model.links.get(navigation.link)?.classification;
      if (!this.access.canSeeModelData(label)) return undefined;
      this.access.observeClassification(label);
    }
    const types = this.model.concreteTypes(args.type).filter(type => (!navigation || type === navigation.target) && this.access.canRead(this.model, type));
    if (!types.length) return undefined;
    const values: unknown[] = [this.owner, types, this.model.projection];
    const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
    const tables = viewTables(this.db, this.model, this.owner, values, [...types, ...(args.from ? [args.from.object.type] : [])], inlineView);
    const policies = types.map(type => {
      this.access.read(this.model, type);
      return `(o.type=${bind(type)} AND ${this.access.rowSql(this.model, type, values, 'o.properties')})`;
    });
    const clauses = ['o.owner=$1', 'o.type=ANY($2::text[])', 'o.projection=$3', '(' + policies.join(' OR ') + ')'];
    if (args.from && navigation) {
      const source = navigation.forward ? 'from' : 'to', target = navigation.forward ? 'to' : 'from';
      clauses.push(`EXISTS(SELECT 1 FROM ${tables.links} l WHERE l.projection=o.projection AND l.owner=o.owner
        AND l.type=${bind(navigation.link)} AND l.${source}_type=${bind(args.from.object.type)} AND l.${source}_id=${bind(args.from.object.id)}
        AND l.${target}_type=o.type AND l.${target}_id=o.id)`);
    }
    const property = this.storedFields(types, values, args.type);
    // Add an indexable necessary condition only for readable, unmarked scalar cells.
    if (types.length === 1 && types[0] === args.type && !processLogTarget(this.model, args.type)
      && !this.access.hasObjectPolicy(this.model, args.type)) {
      const exact = Object.entries(args.where).filter(([field, value]) => value !== null && !field.includes('.')
        && this.access.canSeeModelData(this.model.object(args.type).properties[field]?.classification)
        && this.access.property(this.model, args.type, field));
      if (exact.length) clauses.push(`o.properties @> ${bind(JSON.stringify(Object.fromEntries(exact)))}::jsonb`);
    }
    if (args.intervalOverlap) {
      const window = args.intervalOverlap;
      const fields = [window.start, window.end];
      if (fields.some(field => this.model.propertyPath(args.type, field).format !== 'date-time')
        || !this.mayUseStoredFields(args.type, types, fields))
        throw new Conflict('Time windows require stored date-time properties');
      const timestamp = (field: string) => {
        const raw = `(${property(field)}#>>'{}')`;
        // Date.parse uses millisecond precision, including on offsets in legacy values.
        const millis = `regexp_replace(${raw}, '([.][0-9]{3})[0-9]+', '\\1')`;
        return `(CASE WHEN pg_input_is_valid(${millis},'timestamptz') THEN ${millis}::timestamptz END)`;
      };
      const start = timestamp(window.start), end = timestamp(window.end);
      const overlap = `(${start}<${bind(new Date(window.until).toISOString())}::timestamptz AND ${end}>${bind(new Date(window.from).toISOString())}::timestamptz)`;
      const known = `${start}<${end}`;
      clauses.push(window.includeUnknown ? `((${known}) IS NOT TRUE OR ${overlap})` : `(${known} AND ${overlap})`);
    }
    for (const [field, value] of Object.entries(args.where)) clauses.push(`${property(field)}=${bind(JSON.stringify(value))}::jsonb`);
    return { values, bind, clauses, property, tables, types };
  }
  private storedFields(types: string[], values: unknown[], defaultView: string) {
    const fields = new Map<string, string>();
    const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
    return (path: string, view = defaultView) => {
      const key = JSON.stringify([view, path]), cached = fields.get(key);
      if (cached) return cached;
      const [root, ...nested] = path.split('.');
      if (!this.visibleViewField(view, root!)) return "'null'::jsonb";
      const cases = types.flatMap(type => {
        const local = this.model.propertyName(type, view, root!);
        if (!local) return [];
        const kind = bind(type), allowed = this.access.cellSql(this.model, type, local, values, 'o.properties');
        return [`WHEN o.type=${kind} AND ${allowed} THEN o.properties#>${bind([local, ...nested])}::text[]`];
      });
      const expression = cases.length ? `COALESCE((CASE ${cases.join(' ')} END),'null'::jsonb)` : "'null'::jsonb";
      fields.set(key, expression);
      return expression;
    };
  }
  private async scalarCandidates(args: z.output<typeof querySchema>) {
    const types = this.model.concreteTypes(args.type);
    if (!supportsStoredPredicate(args.filter) ||
      !this.mayUseStoredFields(args.type, types, [...Object.keys(args.where), ...predicateFields(args.filter)])) return undefined;
    const selection = await this.storedSelection(args);
    if (!selection) return { objects: [], ordered: true };
    const { values, bind, clauses, property, tables } = selection;
    if (args.filter) clauses.push(storedPredicate(args.filter, property, bind));
    const ordered = !args.orderBy || this.mayUseStoredFields(args.type, types, args.orderBy.map(item => item.property))
      && args.orderBy.every(item => supportsStoredOrder(this.model.propertyPath(args.type, item.property)));
    const order = ordered ? (args.orderBy ?? []).map(item =>
      `NULLIF(${property(item.property)},'null'::jsonb) ${item.direction.toUpperCase()} NULLS LAST`) : [];
    order.push('to_json(o.type)::text COLLATE "C"', 'to_json(o.id)::text COLLATE "C"');
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
      WHERE ${clauses.join(' AND ')} ORDER BY ${order.join(', ')} LIMIT 10001`, values, this.client);
    if (result.rows.length > 10000) throw new Conflict('Extended query exceeds 10000 matching objects');
    const records = result.rows.map(row => this.row(row));
    await this.linkedSecurityReads(records);
    return { objects: records.map(record => this.visible(record)), ordered };
  }
  async queryStored(input: Query):Promise<{items:ObjectData[];cursor?:string}> {
    if (input.type === scenarioMetadataType) {
      this.requireExclusive('set query');
      if (input.intervalOverlap) throw new Conflict('Time windows require stored date-time properties');
      return scenarioMetadataQuery(this, input);
    }
    const args = querySchema.parse(input);
    // A read of one source's relationship is bounded by object locks; any other set query is not.
    if (!args.from) this.requireExclusive('set query');
    const selection = await this.storedSelection(args);
    if (!selection) return { items: [], cursor: undefined };
    if (args.from) await this.lockRelationshipTargets(args.from.object, args.from.link, args.from.as);
    const { values, bind, clauses, tables, types } = selection;
    const queryDigest = digest({ ...args, cursor: undefined, owner: this.owner, release: this.model.release, scenario: this.model.scenario });
    if (args.cursor) {
      const cursor = z.strictObject({ query: z.literal(queryDigest), type: z.string(), id: z.string() }).parse(decodeQueryCursor(args.cursor));
      clauses.push(`(o.type COLLATE "C",o.id COLLATE "C")>(${bind(cursor.type)},${bind(cursor.id)})`);
    }
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
      WHERE ${clauses.join(' AND ')} ORDER BY o.type COLLATE "C",o.id COLLATE "C" LIMIT ${bind(args.limit + 1)}`, values, this.client);
    const records = result.rows.slice(0, args.limit).map(row => this.row(row));
    await this.linkedSecurityReads(records);
    const fields = args.select ?? Object.keys(this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties).filter(field=>types.some(type=>{const local=this.model.propertyName(type,args.type,field);return local&&!this.model.object(type).properties[local]?.derived;}));
    const items = records.map(object => { this.access.readRow(this.model,object.ref.type,object.properties); return { ...object, properties: Object.fromEntries(fields.flatMap(field => {
      const local = this.model.propertyName(object.ref.type, args.type, field);
      return local === undefined ? [] : [[field, this.visibleViewField(args.type, field) && this.access.cell(this.model, object.ref.type, local, object.properties) ? object.properties[local] : null]];
    })) }; });
    const last = records.at(-1)?.ref;
    return { items, cursor: result.rows.length > args.limit && last ? Buffer.from(JSON.stringify({ query: queryDigest, ...last })).toString('base64url') : undefined };
  }
  /** Compile membership when this read needs no per-row authorization evidence. */
  async storedSetSelection(input: Query, path: readonly { link: string; as?: string }[]) {
    this.requireExclusive('set query');
    const args = querySchema.parse(input), start = args.type;
    const eligible = (type: string) => this.model.objects.has(type) && this.access.canRead(this.model, type)
      && type !== scenarioMetadataType && !processLogTarget(this.model, type) && !this.access.hasObjectPolicy(this.model, type);
    if (args.orderBy || !eligible(start) || !supportsStoredPredicate(args.filter)) return undefined;
    let type = start;
    const hops = [];
    for (const step of path) {
      let navigation;
      try { navigation = this.model.navigation(type, step.link, step.as); }
      catch { return undefined; } // Preserve the interpreter's handling of empty or invalid frontiers.
      if (!eligible(navigation.target)
        || !this.access.canDefine(this.model, 'link', navigation.link)
        || !this.access.canSeeModelData(this.model.links.get(navigation.link)?.classification)
        || step.as && !this.access.canDefine(this.model, 'interface', step.as)) return undefined;
      hops.push({ navigation, as: step.as });
      type = navigation.target;
    }
    const fields = queryFields(args);
    if (!this.mayUseStoredFields(start, [start], fields)) return undefined;
    for (const field of fields) this.model.propertyPath(start, field);
    const selection = await this.storedSelection(args, hops.length > 0);
    if (!selection) return undefined;
    const { values, bind, clauses, tables } = selection;
    if (this.access.canSeeModelData(this.model.document.classification)) {
      this.access.observeClassification(this.model.document.classification);
    }
    if (args.filter) clauses.push(storedPredicate(args.filter, selection.property, bind));
    let prefix = tables.prefix;
    let relation = tables.objects;
    let filter = 'WHERE ' + clauses.join(' AND ');
    if (hops.length) {
      const columns = 'o.type,o.id,o.revision,o.properties';
      relation = 'object_set_seed';
      const steps = [`${relation} AS (SELECT o.id FROM ${tables.objects} o ${filter})`];
      let sourceType = start;
      for (const [index, { navigation: nav, as }] of hops.entries()) {
        if (as) this.access.definition(this.model, 'interface', as, true);
        this.access.definition(this.model, 'link', nav.link, true);
        this.access.read(this.model, nav.target);
        const source = bind(sourceType), target = bind(nav.target), relationship = bind(nav.link);
        const policy = this.access.rowSql(this.model, nav.target, values, 'o.properties');
        const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
        const name = 'object_set_hop_' + index, keys = 'object_set_targets_' + index;
        // Reduce to distinct target identities before the next hop so fan-in never multiplies the frontier.
        steps.push(`${keys} AS MATERIALIZED (
          SELECT DISTINCT l.${to}_id AS id FROM ${tables.links} l JOIN ${relation} frontier ON frontier.id=l.${from}_id
          WHERE l.owner=$1 AND l.projection=$3 AND l.type=${relationship} AND l.${from}_type=${source} AND l.${to}_type=${target}
        )`, `${name} AS (
          SELECT ${columns} FROM ${tables.objects} o JOIN ${keys} target ON target.id=o.id
          WHERE o.owner=$1 AND o.projection=$3 AND o.type=${target} AND ${policy}
        )`);
        relation = name;
        sourceType = nav.target;
      }
      prefix = (prefix ? prefix.trimEnd() + ', ' : 'WITH ') + steps.join(', ') + ' ';
      filter = '';
    }
    const property = hops.length ? this.storedFields([type], values, type) : selection.property;
    return { type, prefix, relation, filter, values, bind, property };
  }
  private recordSetRead() {
    if (this.model.scenario) this.access.recordScenarioRead(this.model, this.model.scenario, this.model.release);
  }
  private async readSetQuery(statement: string, values: unknown[], traversal: boolean) {
    if (traversal) {
      // Fresh projections can drastically underestimate frontier size. Prefer set joins within this Object Set transaction.
      await this.db.query('SET LOCAL enable_nestloop=off', [], this.client);
    }
    return this.db.readQuery(statement, values, this.client);
  }
  async readStoredSet(input: Query, path: readonly { link: string; as?: string }[], limit: number) {
    this.requireExclusive('set query');
    const selection = await this.storedSetSelection(input, path);
    if (!selection || Object.values(this.model.object(selection.type).properties).some(property => property.derived)) return undefined;
    const { prefix, relation, filter, values, bind } = selection;
    const result = await this.readSetQuery(`${prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${relation} o
      ${filter} LIMIT ${bind(limit + 1)}`, values, path.length > 0);
    if (result.rows.length > limit) throw new Conflict('Object set exceeds the complete evaluation limit');
    this.recordSetRead();
    return result.rows.map(row => this.visible(this.row(row)));
  }
  /** Keep eligible set membership and reduction inside PostgreSQL. */
  async aggregateStored(input: Query, view: string | undefined, groupBy: string[], metrics: Record<string, Metric>, groupLimit: number,
    path: readonly { link: string; as?: string }[]) {
    this.requireExclusive('set query');
    const selection = await this.storedSetSelection(input, path);
    if (!selection) return undefined;
    const { type, prefix, relation, filter, values, bind, property } = selection;
    const outputView = view ?? type;
    if (!this.model.implements(type, outputView)) return undefined;
    const metricEntries = Object.entries(metrics);
    const groupFields = [...groupBy, ...metricEntries.flatMap(([, metric]) => metric.property ? [metric.property] : [])];
    if (!this.mayUseStoredFields(outputView, [type], groupFields)) return undefined;
    for (const field of groupFields) this.model.propertyPath(outputView, field);
    if (metricEntries.some(([, metric]) => metric.op !== 'count' && !isNumeric(this.model.propertyPath(outputView, metric.property)))) return undefined;
    const groups = groupBy.map((field, index) => `NULLIF(${property(field, outputView)},'null'::jsonb) AS g${index}`);
    const aggregates = metricEntries.map(([, metric], index) => {
      const field = metric.property ? `NULLIF(${property(metric.property, outputView)},'null'::jsonb)` : '*';
      const operand = metric.op === 'count' ? field : `(${field})::double precision`;
      return `${metric.op.toUpperCase()}(${operand}) AS m${index}`;
    });
    const group = groups.length ? 'GROUP BY ' + groupBy.map((_, index) => 'g' + index).join(', ') : '';
    const statement = `${prefix}SELECT COUNT(*) AS count,${[...groups, ...aggregates].join(', ')}
      FROM ${relation} o ${filter} ${group}
      ORDER BY MIN(to_json(o.id)::text COLLATE "C") LIMIT ${bind(groupLimit + 1)}`;
    const rows = await this.readSetQuery(statement, values, path.length > 0)
      .catch(error => {
        if (error?.code === '22003') throw new Conflict('Numeric aggregation overflow');
        throw error;
      });
    if (rows.rows.length > groupLimit) throw new Conflict('Object set exceeds the aggregate group limit');
    this.recordSetRead();
    return {
      count: rows.rows.reduce((total, row) => total + Number(row.count), 0),
      items: rows.rows.map(row => ({
        group: Object.fromEntries(groupBy.map((field, index) => [field, row['g' + index]])),
        metrics: Object.fromEntries(metricEntries.map(([name], index) => {
          const value = row['m' + index] === null ? null : Number(row['m' + index]);
          if (value !== null && !Number.isFinite(value)) throw new Conflict('Numeric aggregation overflow');
          return [name, value];
        })),
      })),
    };
  }
  /** Object Set frontiers have already been read within this transaction. Recheck both endpoints in the join. */
  async followSet(sourceType: string, ids: string[], link: string, as: string | undefined, maximum: number) {
    this.requireExclusive('set query');
    const nav = this.model.navigation(sourceType, link, as);
    if ([sourceType, nav.target].some(type => type === scenarioMetadataType || processLogTarget(this.model, type))
      || Object.values(this.model.object(nav.target).properties).some(property => property.derived)) return undefined;
    if (as) this.access.definition(this.model, 'interface', as);
    this.access.read(this.model, sourceType);
    this.access.read(this.model, nav.target);
    this.access.definition(this.model, 'link', nav.link);
    const label = this.model.links.get(nav.link)?.classification;
    if (!this.access.canSeeModelData(label)) return [];
    this.access.observeClassification(label);
    await checkScenario(this.db, this.model, this.owner, this.client);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    const values: unknown[] = [this.owner, this.model.projection, sourceType, ids, nav.link, nav.target, maximum + 1];
    const tables = viewTables(this.db, this.model, this.owner, values, [sourceType, nav.target]);
    const sourcePolicy = this.access.rowSql(this.model, sourceType, values, 's.properties');
    const targetPolicy = this.access.rowSql(this.model, nav.target, values, 'o.properties');
    // Start from the sources' relationship rows, which the endpoint indexes find, instead of testing every target.
    const result = await this.db.readQuery(`${tables.prefix}SELECT DISTINCT ON (o.type,o.id) o.type,o.id,o.revision,o.properties
      FROM ${tables.links} l
      JOIN ${tables.objects} s ON s.projection=l.projection AND s.owner=l.owner AND (s.type,s.id)=(l.${from}_type,l.${from}_id)
      JOIN ${tables.objects} o ON o.projection=l.projection AND o.owner=l.owner AND (o.type,o.id)=(l.${to}_type,l.${to}_id)
      WHERE l.owner=$1 AND l.projection=$2 AND l.type=$5 AND l.${from}_type=$3 AND l.${from}_id=ANY($4::text[])
        AND s.type=$3 AND ${sourcePolicy} AND o.type=$6 AND ${targetPolicy}
      ORDER BY o.type,o.id LIMIT $7`, values, this.client);
    if (result.rows.length > maximum) throw new Conflict('Object set exceeds the complete evaluation limit');
    const records = result.rows.map(row => this.row(row));
    await this.linkedSecurityReads(records);
    return records.map(record => this.visible(record));
  }
  async follow(ref: ObjectRef, link: string, view = ref.type, maximum?: number): Promise<ObjectData[]> {
    if (maximum !== undefined && (!Number.isInteger(maximum) || maximum < 1 || maximum > maxCompleteRelationships))
      throw new InvalidInput('Relationship read limit is out of range');
    return observeDecisionRead(this, { kind: 'follow', ref, link, as: view, ...(maximum === undefined ? {} : { maximum }) },
      () => this.followObjects(ref, link, view, maximum ?? maxCompleteRelationships), observedObjects);
  }
  private async followObjects(ref: ObjectRef, link: string, view: string, maximum: number): Promise<ObjectData[]> {
    if (view !== ref.type) this.access.definition(this.model, 'interface', view);
    const nav = this.model.navigation(ref.type, link, view);
    if(this.client===this.db.pool&&[ref.type,nav.target].some(type=>Object.values(this.model.object(type).properties).some(property=>property.derived))) {
      const access=await this.access.fork();
      const result=await this.db.transaction(async client=>{
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
        return new Objects(this.db,this.model,access,client).follow(ref,link,view,maximum);
      });
      if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Derived result permissions changed');
      this.access.adoptReads(access);return result;
    }
    await this.read(ref); this.access.read(this.model, nav.target); this.access.definition(this.model, 'link', nav.link);
    await this.lockRelationshipTargets(ref, link, view);
    const label = this.model.links.get(nav.link)?.classification;
    if (!this.access.canSeeModelData(label)) return [];
    this.access.observeClassification(label);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    await checkScenario(this.db, this.model, this.owner, this.client);
    const values: unknown[] = [this.owner, nav.link, ref.type, ref.id, this.model.projection];
    const policy = this.access.rowSql(this.model,nav.target,values,'o.properties');
    const tables = viewTables(this.db, this.model, this.owner, values,[ref.type,nav.target]);
    const limit = values.push(maximum + 1);
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.links} l
      JOIN ${tables.objects} o ON o.projection=l.projection AND o.owner=l.owner AND o.type=l.${to}_type AND o.id=l.${to}_id
      WHERE l.owner=$1 AND l.type=$2 AND l.${from}_type=$3 AND l.${from}_id=$4 AND l.projection=$5 AND ${policy} ORDER BY o.id COLLATE "C" LIMIT $${limit}`, values, this.client);
    if (result.rows.length > maximum) throw new Conflict('Relationship exceeds the complete read limit. Use a paginated query through the Link.');
    await this.linkedSecurityReads(result.rows.map(row=>this.row(row)));
    if(nav.target===scenarioMetadataType){
      const items:ObjectData[]=[];
      for(const row of result.rows)try{items.push(await scenarioMetadataRead(this,{type:scenarioMetadataType,id:String(row.id)}));}catch(error){if(!(error instanceof NotFound))throw error;}
      return items;
    }
    const evaluator=new DerivedProperties(this), targets=result.rows.map(row=>this.visible(this.row(row)));
    await evaluator.prefetch(targets);
    return Promise.all(targets.map(object=>evaluator.enrich(object)));
  }
  async create(ref: ObjectRef, input: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).create(ref, input));
    this.writeType(ref.type); await this.prepareWrite(); await this.lockObjects([ref], 'exclusive');
    this.assertStoredFields(ref,input);
    const properties = this.model.parseObject(ref, input);
    this.access.writeRow(this.model,ref.type,properties);
    if (this.model.scenario) {
      const old = await this.stored(ref).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
      if (old) { if (digest(old.properties) !== digest(properties)) throw new Conflict('Object identity already contains different data'); return; }
      await stageObject(this.db, this.model, this.owner, ref, 1, properties, this.client, Object.keys(input), { op: 'create', journal: this.change?.scenarioEdits }); return;
    }
    const result = await this.db.query(`INSERT INTO ${this.db.schema}.objects(owner,type,id,properties,projection) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [this.owner, ref.type, ref.id, properties, this.model.projection], this.client);
    if (!result.rowCount) {
      if (digest((await this.stored(ref)).properties) !== digest(properties)) throw new Conflict('Object identity already contains different data');
    } else await recordObjectEdit(this,ref,null,properties,properties,'create');
  }
  async ingestBatch(input: readonly { ref: ObjectRef; properties: Record<string,unknown> | null }[], source = 'default', observedAt?: string): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client=>new Objects(this.db,this.model,this.access,client,this.change).ingestBatch(input,source,observedAt));
    await this.prepareWrite();
    if (this.model.scenario) throw new Conflict('Source ingestion is unavailable inside a scenario');
    const unique = new Map<string,{ref:ObjectRef;properties:Record<string,unknown>|null}>();
    for (const item of input) {
      this.writeType(item.ref.type);
      if(item.properties)this.assertStoredFields(item.ref,item.properties);
      const properties = item.properties === null ? null : this.model.parseObject(item.ref,item.properties);
      const key = JSON.stringify(item.ref), prior = unique.get(key);
      if (prior && digest(prior.properties)!==digest(properties)) throw new Conflict('Source rows disagree about one object');
      unique.set(key,{ref:item.ref,properties});
    }
    await this.lockObjects([...unique.values()].map(entry => entry.ref), 'exclusive');
    const entries = [...unique.values()], stored = await this.storedSources(entries.map(entry => entry.ref));
    const observations = entries.map(({ref,properties}) => {
      if (properties) this.access.sourceRow(this.model,ref.type,properties);
      const old = stored.get(JSON.stringify([ref.type,ref.id]));
      if (old?.visible) this.access.sourceRow(this.model,ref.type,old.visible.properties);
      return { ref, incoming: properties, before: old?.raw ?? null };
    });
    const removed: ObjectRef[] = [], written: { type: string; id: string; properties: Record<string, unknown> }[] = [];
    (await resolveSourceEdits(this,observations,source,observedAt)).forEach(({ value, current }, index) => {
      const { ref } = entries[index]!;
      if (value) this.access.sourceRow(this.model,ref.type,value);
      if (!current) return;
      if (value === null) removed.push(ref); else written.push({ type: ref.type, id: ref.id, properties: value });
    });
    const scope = [this.model.projection,this.owner], rows = (refs: readonly ObjectRef[]) => JSON.stringify(refs.map(({type,id}) => ({type,id})));
    // Deleting an object deletes its relationships with objects this commit has not locked.
    if (removed.length) this.requireExclusive('source deletion');
    if (removed.length) {
      const values: unknown[] = [...scope,rows(removed)];
      await this.db.query(`WITH removed AS (DELETE FROM ${this.db.schema}.links l USING jsonb_to_recordset($3::jsonb) AS k(type text,id text)
        WHERE l.projection=$1 AND l.owner=$2 AND ((l.from_type=k.type AND l.from_id=k.id) OR (l.to_type=k.type AND l.to_id=k.id))
        RETURNING l.type,l.from_type,l.from_id,l.to_type,l.to_id) ${journalLinks(this,'unlink','removed','$1','$2',values,source)}`,values,this.client);
      await this.db.query(`DELETE FROM ${this.db.schema}.objects o USING jsonb_to_recordset($3::jsonb) AS k(type text,id text)
        WHERE o.projection=$1 AND o.owner=$2 AND o.type=k.type AND o.id=k.id`,[...scope,rows(removed)],this.client);
    }
    if (written.length) await this.db.query(`INSERT INTO ${this.db.schema}.objects AS o(projection,owner,type,id,properties)
      SELECT $1,$2,r.type,r.id,r.properties FROM jsonb_to_recordset($3::jsonb) AS r(type text,id text,properties jsonb)
      ON CONFLICT(projection,owner,type,id) DO UPDATE SET properties=excluded.properties,revision=o.revision+1
      WHERE o.properties IS DISTINCT FROM excluded.properties`,[...scope,JSON.stringify(written)],this.client);
  }
  /** Stored rows for source ingestion: the raw value it replaces, and the parsed value when the caller may see it. */
  private async storedSources(refs: readonly ObjectRef[]) {
    const found = new Map<string, { raw: Record<string, unknown>; visible?: ObjectData }>();
    if (!refs.length) return found;
    const { rows } = await this.db.query(`SELECT o.type,o.id,o.revision,o.properties FROM ${this.db.schema}.objects o
      JOIN jsonb_to_recordset($3::jsonb) AS k(type text,id text) ON o.type=k.type AND o.id=k.id
      WHERE o.projection=$1 AND o.owner=$2`, [this.model.projection, this.owner, JSON.stringify(refs.map(({type,id}) => ({type,id})))], this.client);
    for (const row of rows) {
      const ref = { type: String(row.type), id: String(row.id) };
      // Row policies decide whether a document chunk counts as an existing visible row, as for a single read.
      const visible = ref.type === documentChunkType || processLogTarget(this.model, ref.type)
        ? await this.stored(ref).catch(error => { if (error instanceof NotFound) return undefined; throw error; })
        : this.row(row);
      found.set(JSON.stringify([ref.type, ref.id]), { raw: row.properties as Record<string, unknown>, visible });
    }
    return found;
  }
  async edit(ref: ObjectRef, revision: number, fields: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).edit(ref, revision, fields));
    this.writeType(ref.type); await this.prepareWrite(); await this.lockObjects([ref], 'exclusive');
    this.assertStoredFields(ref,fields);
    const old = await this.stored(ref), properties = this.model.parseObject(ref, { ...old.properties, ...fields });
    this.access.readRow(this.model,ref.type,old.properties);
    for (const field of Object.keys(fields)) if (!this.access.cell(this.model,ref.type,field,old.properties)) throw new PermissionDenied('Cannot edit a hidden property');
    this.access.writeRow(this.model,ref.type,properties);
    if (old.revision !== revision) throw new Conflict('Object revision changed');
    if (this.model.scenario) {
      await stageObject(this.db, this.model, this.owner, ref, revision + 1, properties, this.client, Object.keys(fields), { op: 'edit', journal: this.change?.scenarioEdits }); return;
    }
    const result = await this.db.query(`UPDATE ${this.db.schema}.objects SET properties=$4,revision=revision+1 WHERE owner=$1 AND type=$2 AND id=$3 AND revision=$5 AND projection=$6`, [this.owner, ref.type, ref.id, properties, revision, this.model.projection], this.client);
    if (!result.rowCount) throw new Conflict('Object revision changed');
    await recordObjectEdit(this,ref,old.properties,properties,fields,'edit');
  }
  async link(edge: LinkData) {
    return this.linkBatch([edge]);
  }
  async linkBatch(edges: readonly LinkData[]): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).linkBatch(edges));
    await this.prepareWrite();
    if (!edges.length) return;
    await this.lockObjects(edges.flatMap(edge => [edge.from, edge.to]), 'exclusive');
    for (const edge of edges) { await this.read(edge.from); await this.read(edge.to); }
    const rows = edges.map(edge => {
      this.access.definition(this.model, 'link', edge.type); this.writeType(edge.from.type,true); this.writeType(edge.to.type,true);
      const definition = this.model.links.get(edge.type);
      if (!definition || edge.from.type !== definition.from.type || edge.to.type !== definition.to.type) throw new InvalidInput('Invalid link endpoints');
      return { type: edge.type, from_type: edge.from.type, from_id: edge.from.id, to_type: edge.to.type, to_id: edge.to.id, single_from: definition.from.cardinality === 'one', single_to: definition.to.cardinality === 'one' };
    });
    if (this.model.scenario) {
      for (const edge of edges) {
        await this.stored(edge.from); await this.stored(edge.to);
        const definition = this.model.links.get(edge.type)!;
        const singleFrom = definition.from.cardinality === 'one', singleTo = definition.to.cardinality === 'one';
        if (singleFrom || singleTo) {
          const values: unknown[] = [this.model.projection, this.owner, edge.type, edge.from.type, edge.from.id,
            edge.to.type, edge.to.id, singleFrom, singleTo];
          const tables = viewTables(this.db, this.model, this.owner, values, [], true);
          const { rows: [row] } = await this.db.query(`${tables.prefix}SELECT EXISTS(
            SELECT 1 FROM ${tables.links} WHERE projection=$1 AND owner=$2 AND type=$3
            AND (($8 AND (from_type,from_id)=($4,$5) AND (to_type,to_id)<>($6,$7))
              OR ($9 AND (to_type,to_id)=($6,$7) AND (from_type,from_id)<>($4,$5)))
          ) AS conflicting`, values, this.client);
          if (row?.conflicting) throw new Conflict('Link cardinality exceeded');
        }
        await stageLink(this.db, this.model, this.owner, edge, false, this.client, this.change?.scenarioEdits);
      }
      return;
    }
    try {
      // Only relationships this commit adds are journaled; an existing one is left as it is.
      const values: unknown[] = [this.owner, JSON.stringify(rows), this.model.projection];
      await this.db.query(`WITH added AS (INSERT INTO ${this.db.schema}.links(owner,type,from_type,from_id,to_type,to_id,single_from,single_to,projection)
        SELECT $1,type,from_type,from_id,to_type,to_id,single_from,single_to,$3 FROM jsonb_to_recordset($2::jsonb)
        AS input(type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)
        ON CONFLICT(projection,owner,type,from_type,from_id,to_type,to_id) DO NOTHING
        RETURNING type,from_type,from_id,to_type,to_id) ${journalLinks(this,'link','added','$3','$1',values)}`, values, this.client);
    } catch (error) {
      const databaseError = error as { code?: string; constraint?: string } | null;
      if (databaseError?.code === '23505' &&
        (databaseError.constraint === 'links_single_from' || databaseError.constraint === 'links_single_to'))
        throw new Conflict('Link cardinality exceeded');
      throw error;
    }
  }
  async unlink(edge: LinkData): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).unlink(edge));
    await this.prepareWrite(); this.access.definition(this.model, 'link', edge.type);
    await this.lockObjects([edge.from, edge.to], 'exclusive');
    await this.read(edge.from); await this.read(edge.to);
    this.writeType(edge.from.type,true); this.writeType(edge.to.type,true);
    const definition = this.model.links.get(edge.type);
    if (!definition || definition.from.type !== edge.from.type || definition.to.type !== edge.to.type) throw new InvalidInput('Invalid link endpoints');
    if (this.model.scenario) return stageLink(this.db, this.model, this.owner, edge, true, this.client, this.change?.scenarioEdits);
    const values: unknown[] = [this.model.projection, this.owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id];
    await this.db.query(`WITH removed AS (DELETE FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7
      RETURNING type,from_type,from_id,to_type,to_id) ${journalLinks(this,'unlink','removed','$1','$2',values)}`, values, this.client);
  }
  async remove(ref: ObjectRef, revision: number): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).remove(ref, revision));
    await this.prepareWrite(); this.writeType(ref.type); await this.lockObjects([ref], 'exclusive');
    const old = await this.stored(ref);
    this.access.readRow(this.model,ref.type,old.properties);
    for (const field of Object.keys(old.properties)) if (!this.access.cell(this.model,ref.type,field,old.properties)) throw new PermissionDenied('Cannot delete an object with hidden properties');
    if (old.revision !== revision) throw new Conflict('Object revision changed');
    const edges = new Map<string, LinkData>();
    for (const link of this.model.links.values()) {
      if (processLogTarget(this.model, link.from.type) || processLogTarget(this.model, link.to.type)) continue;
      // Unavailable sandbox relationships are still counted by the physical-edge check below.
      if (!this.db.sandboxEnabled && [link.from.type, link.to.type].some(type => isSandboxResource(this.model, 'object', type))) continue;
      for (const side of ['from', 'to'] as const) if (link[side].type === ref.type) {
        for (const other of await this.follow(ref, link[side].name)) {
          const edge = { type: link.apiName, from: side === 'from' ? ref : other.ref, to: side === 'to' ? ref : other.ref };
          edges.set(digest(edge), edge);
          if (edges.size > maxCompleteRelationships) throw new Conflict('Unlink relationships in smaller groups before deleting this object');
        }
      }
    }
    // Compare authorized edges with physical edges without returning hidden endpoints or counts.
    const values: unknown[] = [this.model.projection, this.owner, ref.type, ref.id, edges.size];
    const tables = viewTables(this.db, this.model, this.owner, values, [], true);
    const { rows: [incident] } = await this.db.query(`${tables.prefix}SELECT EXISTS(
      SELECT 1 FROM ${tables.links} WHERE projection=$1 AND owner=$2
      AND ((from_type=$3 AND from_id=$4) OR (to_type=$3 AND to_id=$4))
      LIMIT 1 OFFSET $5
    ) AS hidden`, values, this.client);
    if (incident?.hidden) throw new PermissionDenied('Cannot delete an object with inaccessible relationships');
    for (const edge of edges.values()) await this.unlink(edge);
    if (this.model.scenario) return stageObject(this.db, this.model, this.owner, ref, revision + 1, null, this.client, [], { op: 'delete', journal: this.change?.scenarioEdits });
    await this.db.query(`DELETE FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND revision=$5`, [this.model.projection, this.owner, ref.type, ref.id, revision], this.client);
    await recordObjectEdit(this,ref,old.properties,null,undefined,'delete');
  }

}
